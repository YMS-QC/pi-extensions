import { createHash } from "node:crypto";
import { complete } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CLASSIFIER_DETAILED_INSTRUCTION,
  CLASSIFIER_FAST_INSTRUCTION,
  CLASSIFIER_SYSTEM_PROMPT,
} from "./constants.ts";
import { formatModelSpec, parseModelSpec } from "./model.ts";
import { buildClassifierTranscript } from "./transcript.ts";
import type {
  ClassificationDecision,
  ClassifyAction,
  ClassifierIoAttempt,
  ClassifyResult,
  EffectiveConfig,
} from "./types.ts";

export function buildClassifierPrompt(config: EffectiveConfig): string {
  return CLASSIFIER_SYSTEM_PROMPT.replace(
    "<ENVIRONMENT>",
    config.environment.map((line) => `- ${line}`).join("\n"),
  )
    .replace(
      "<ALLOW_RULES>",
      config.allow.map((line) => `- ${line}`).join("\n"),
    )
    .replace(
      "<SOFT_DENY_RULES>",
      config.softDeny.map((line) => `- ${line}`).join("\n"),
    )
    .replace(
      "<HARD_DENY_RULES>",
      config.hardDeny.map((line) => `- ${line}`).join("\n"),
    );
}

async function resolveClassifier(
  ctx: ExtensionContext,
  config: EffectiveConfig,
): Promise<
  | { model: Model<any>; apiKey?: string; headers?: Record<string, string> }
  | undefined
> {
  const configured = config.classifierModel;
  const model = configured
    ? (() => {
      const parsed = parseModelSpec(configured);
      return parsed
        ? ctx.modelRegistry.find(parsed.provider, parsed.id)
        : undefined;
    })()
    : ctx.model;
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;
  return { model, apiKey: auth.apiKey, headers: auth.headers };
}

export type ClassifierCompletionFn = (
  model: Model<any>,
  options: { systemPrompt: string; messages: UserMessage[] },
  callOptions: {
    apiKey?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    maxTokens: number;
    temperature?: number;
    sessionId?: string;
    cacheRetention?: "none" | "short" | "long";
  },
) => Promise<AssistantMessage>;

export type RetryOptions = {
  maxAttempts?: number;
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  cacheRetention?: "none" | "short" | "long";
  stage?: "fast" | "detailed";
  /** Receives each attempt's raw response (or error) and parsed decision, for observability logging. */
  onAttempt?: (attempt: ClassifierIoAttempt) => void;
};

const FAST_CLASSIFIER_MAX_TOKENS = 4;

export type StagedClassifierOptions = {
  sessionId: string;
  onAttempt?: (attempt: ClassifierIoAttempt) => void;
};

/** Concatenate all text blocks of an assistant message into a single string. */
function extractAssistantText(message: AssistantMessage, trim = true): string {
  const text = message.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
  return trim ? text.trim() : text;
}

/** Parse the exact detailed-stage JSON contract; any wrapper or shape drift fails closed. */
export function parseClassifierDecision(
  message: AssistantMessage,
): ClassificationDecision | undefined {
  const text = extractAssistantText(message);
  const validTiers = new Set<ClassificationDecision["tier"]>([
    "hard_deny",
    "soft_deny",
    "allow",
    "explicit_intent",
    "none",
  ]);
  try {
    for (const key of ["decision", "tier", "reason"]) {
      const occurrences = text.match(new RegExp(`"${key}"\\s*:`, "g"))?.length ?? 0;
      if (occurrences !== 1) return undefined;
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const keys = Object.keys(parsed).sort();
    if (keys.join(",") !== "decision,reason,tier") return undefined;
    if (parsed.decision !== "allow" && parsed.decision !== "block") {
      return undefined;
    }
    if (!validTiers.has(parsed.tier as ClassificationDecision["tier"])) {
      return undefined;
    }
    const tier = parsed.tier as ClassificationDecision["tier"];
    if (
      (parsed.decision === "allow" &&
        !["allow", "explicit_intent", "none"].includes(tier)) ||
      (parsed.decision === "block" &&
        !["hard_deny", "soft_deny", "none"].includes(tier))
    ) {
      return undefined;
    }
    if (typeof parsed.reason !== "string" || parsed.reason.trim() === "") {
      return undefined;
    }
    return {
      decision: parsed.decision,
      tier,
      reason: parsed.reason,
    };
  } catch {
    return undefined;
  }
}

function stageMessage(text: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function responseAttempt(
  stage: "fast" | "detailed",
  attempt: number,
  response: AssistantMessage,
  durationMs: number,
  parsed?: ClassificationDecision,
  trimText = true,
): ClassifierIoAttempt {
  return {
    stage,
    attempt,
    response: {
      stopReason: response.stopReason,
      text: extractAssistantText(response, trimText),
      model: response.model,
      timestamp: response.timestamp,
      usage: response.usage,
      ...(response.errorMessage === undefined
        ? {}
        : { errorMessage: response.errorMessage }),
    },
    parsed,
    durationMs,
  };
}

function classifierFailure(
  response: AssistantMessage,
  label: "Classifier" | "Fast classifier",
  retryLength = false,
): ClassificationDecision | undefined {
  if (
    response.stopReason === "stop" ||
    (retryLength && response.stopReason === "length")
  ) {
    return undefined;
  }
  const fallback = response.stopReason === "aborted"
    ? "Classifier model request was aborted."
    : response.stopReason === "error"
    ? "Classifier model returned an error response."
    : `${label} response did not stop cleanly (${response.stopReason}).`;
  return {
    decision: "block",
    tier: "none",
    reason: `${label} failed; auto mode fails closed: ${
      response.errorMessage || fallback
    }`,
  };
}

/**
 * Call the detailed classifier and parse its decision, retrying malformed or
 * truncated output. Provider errors and exhausted retries fail closed.
 */
export async function classifyWithRetry(
  completeFn: ClassifierCompletionFn,
  classifier: {
    model: Model<any>;
    apiKey?: string;
    headers?: Record<string, string>;
  },
  prompt: { systemPrompt: string; messages: UserMessage[] },
  signal: AbortSignal | undefined,
  options: RetryOptions = {},
): Promise<ClassificationDecision> {
  const maxAttempts = options.maxAttempts ?? 2;
  const maxTokens = options.maxTokens ?? 1200;
  const temperature = options.temperature;
  const stage = options.stage ?? "detailed";
  const onAttempt = options.onAttempt;
  let lastReason =
    "Classifier response was not valid decision JSON; auto mode fails closed.";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const started = Date.now();
    let response: AssistantMessage;
    try {
      response = await completeFn(
        classifier.model,
        prompt,
        {
          apiKey: classifier.apiKey,
          headers: classifier.headers,
          signal,
          maxTokens,
          ...(temperature === undefined ? {} : { temperature }),
          sessionId: options.sessionId,
          cacheRetention: options.cacheRetention,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onAttempt?.({
        stage,
        attempt: attempt + 1,
        error: message,
        durationMs: Date.now() - started,
      });
      return {
        decision: "block",
        tier: "none",
        reason: `Classifier failed; auto mode fails closed: ${message}`,
      };
    }
    const durationMs = Date.now() - started;
    const failure = classifierFailure(response, "Classifier", true);
    const decision = response.stopReason === "stop"
      ? parseClassifierDecision(response)
      : undefined;
    onAttempt?.(
      responseAttempt(stage, attempt + 1, response, durationMs, decision, false),
    );
    if (failure) return failure;
    if (decision) return decision;
    lastReason =
      response.stopReason === "length"
        ? "Classifier response was truncated before producing valid decision JSON; auto mode fails closed."
        : "Classifier response was not valid decision JSON; auto mode fails closed.";
  }
  return { decision: "block", tier: "none", reason: lastReason };
}

/** Run the one-token conservative gate, then detailed review only when requested. */
export async function classifyInStages(
  completeFn: ClassifierCompletionFn,
  classifier: {
    model: Model<any>;
    apiKey?: string;
    headers?: Record<string, string>;
  },
  prompt: { systemPrompt: string; contextMessage: UserMessage },
  signal: AbortSignal | undefined,
  options: StagedClassifierOptions,
): Promise<ClassificationDecision> {
  const fastStarted = Date.now();
  let fastResponse: AssistantMessage;
  try {
    fastResponse = await completeFn(
      classifier.model,
      {
        systemPrompt: prompt.systemPrompt,
        messages: [
          prompt.contextMessage,
          stageMessage(CLASSIFIER_FAST_INSTRUCTION),
        ],
      },
      {
        apiKey: classifier.apiKey,
        headers: classifier.headers,
        signal,
        // Some OpenAI-compatible servers count an initial control token and
        // EOS against max_tokens. Four tokens reliably permit one visible digit.
        maxTokens: FAST_CLASSIFIER_MAX_TOKENS,
        sessionId: options.sessionId,
        cacheRetention: "short",
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onAttempt?.({
      stage: "fast",
      attempt: 1,
      error: message,
      durationMs: Date.now() - fastStarted,
    });
    return {
      decision: "block",
      tier: "none",
      reason: `Fast classifier failed; auto mode fails closed: ${message}`,
    };
  }

  const fastText = extractAssistantText(fastResponse, false);
  const failure = classifierFailure(fastResponse, "Fast classifier");
  options.onAttempt?.(
    responseAttempt(
      "fast",
      1,
      fastResponse,
      Date.now() - fastStarted,
      undefined,
      false,
    ),
  );
  if (failure) return failure;
  if (fastText === "0") {
    return {
      decision: "allow",
      tier: "none",
      reason: "Fast classifier found no policy-relevant risk.",
    };
  }
  if (fastText !== "1") {
    return {
      decision: "block",
      tier: "none",
      reason:
        "Fast classifier response was not exactly 0 or 1; auto mode fails closed.",
    };
  }

  return classifyWithRetry(
    completeFn,
    classifier,
    {
      systemPrompt: prompt.systemPrompt,
      messages: [
        prompt.contextMessage,
        stageMessage(CLASSIFIER_DETAILED_INSTRUCTION),
      ],
    },
    signal,
    {
      stage: "detailed",
      sessionId: options.sessionId,
      cacheRetention: "short",
      onAttempt: options.onAttempt,
    },
  );
}

export function classifierCacheSessionId(ctx: ExtensionContext): string {
  const source = ctx.sessionManager.getSessionId?.() ??
    ctx.sessionManager.getSessionFile?.() ?? ctx.cwd;
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 32);
  return `pi-automode-${digest}`;
}

export const defaultClassifyAction: ClassifyAction = async (
  ctx,
  config,
  action,
  loadedContext,
): Promise<ClassifyResult> => {
  const classifier = await resolveClassifier(ctx, config);
  if (!classifier) {
    return {
      decision: "block",
      tier: "none",
      reason: "No classifier model/API key available; auto mode fails closed.",
    };
  }

  const systemPrompt = buildClassifierPrompt(config);
  const transcript = buildClassifierTranscript(ctx, {
    maxUserTokens: config.maxUserTranscriptTokens,
    maxToolTokens: config.maxToolTranscriptTokens,
  });
  const contextText = `<loaded-project-instructions>\n${
    loadedContext || "(none)"
  }\n</loaded-project-instructions>\n\n<classifier-transcript>\n${
    transcript || "(none)"
  }\n</classifier-transcript>\n\nLatest action to classify:\n${action}`;
  const contextMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: contextText }],
    timestamp: Date.now(),
  };

  const attempts: ClassifierIoAttempt[] = [];
  const started = Date.now();
  const decision = await classifyInStages(
    complete,
    classifier,
    { systemPrompt, contextMessage },
    ctx.signal,
    {
      sessionId: classifierCacheSessionId(ctx),
      onAttempt: (attempt) => attempts.push(attempt),
    },
  );

  return {
    ...decision,
    io: {
      model: formatModelSpec(classifier.model),
      prompt: {
        system: systemPrompt,
        context: contextText,
        fastInstruction: CLASSIFIER_FAST_INSTRUCTION,
        detailedInstruction: CLASSIFIER_DETAILED_INSTRUCTION,
      },
      attempts,
      durationMs: Date.now() - started,
    },
  };
};
