import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  classifierReasoningForConfig,
  defaultClassifyAction,
} from "./classifier.ts";
import {
  AUTO_MODE_GUIDANCE,
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SOFT_DENY,
  PATH_BEARING_TOOLS,
  READ_ONLY_TOOLS,
} from "./constants.ts";import {
  loadEffectiveConfig,
  loadEffectiveConfigWithDiagnostics,
  writeGlobalClassifierModel,
} from "./config.ts";
import { deterministicHardDeny } from "./hard-deny.ts";
import {
  createLogger,
  newDecisionId,
  resolveLogPath,
  type Logger,
} from "./log.ts";
import { formatModelSpec, parseModelSpec } from "./model.ts";
import { promptForClassifierModel } from "./model-selector.ts";
import { matchesDeniedPath, matchesToolPattern } from "./permissions.ts";
import {
  expandHomePattern,
  extractInputPath,
  isInside,
  isProtectedPath,
  resolveInputPath,
  resolvePathForPolicy,
} from "./paths.ts";
import {
  actionSummary,
  formatDenials,
  pushDenial,
  restoreState,
  statusLine,
  statusText,
} from "./state.ts";
import { loadedContextFromSystemPromptOptions } from "./transcript.ts";
import type {
  AutoModeState,
  ClassifierReasoningLog,
  ClassifyAction,
  ClassifyResult,
  ConfigLoadResult,
  DecisionKind,
  DenialRecord,
  EffectiveConfig,
} from "./types.ts";
import { safeJson } from "./utils.ts";

export type PiAutomodeOptions = {
  /** Override config loading in tests. Runtime code uses Pi-owned disk settings. */
  loadConfig?: (cwd: string) => EffectiveConfig;
  /** Override classifier calls in tests so unit tests never need a real LLM/API key. */
  classifyAction?: ClassifyAction;
  /** Override classifier-model persistence in tests. Runtime code writes ~/.pi/agent/automode.json. */
  saveClassifierModel?: (classifierModel: string) => void;
};

type LogCtx = {
  logger: Logger;
  decisionId: string;
  classifierModel?: string;
  reasoning: ClassifierReasoningLog;
};

/** Append ccusage-compatible usage and optional classifier I/O entries. */
function logClassifierIo(decision: ClassifyResult, log: LogCtx): void {
  if (decision.reasoning) log.reasoning = decision.reasoning;
  if (decision.io) log.reasoning = decision.io.reasoning;
  if (!log.logger.enabled || !decision.io) return;

  for (const attempt of decision.io.attempts) {
    const response = attempt.response;
    if (!response) continue;
    log.logger.append({
      type: "message",
      timestamp: new Date(response.timestamp).toISOString(),
      message: {
        role: "assistant",
        model: response.model,
        usage: response.usage,
      },
    });
  }

  if (!log.logger.classifierIo) return;
  log.logger.append({
    type: "classifier",
    ts: new Date().toISOString(),
    decisionId: log.decisionId,
    model: decision.io.model,
    reasoning: decision.io.reasoning,
    prompt: decision.io.prompt,
    attempts: decision.io.attempts,
    durationMs: decision.io.durationMs,
    parsed: {
      decision: decision.decision,
      tier: decision.tier,
      reason: decision.reason,
    },
  });
}

/** Create a Pi extension instance. Default export uses production dependencies. */
export function createPiAutomode(options: PiAutomodeOptions = {}) {
  const loadConfigWithDiagnostics = options.loadConfig
    ? (cwd: string): ConfigLoadResult => ({
      config: options.loadConfig?.(cwd) ?? loadEffectiveConfig(cwd),
      diagnostics: [],
    })
    : loadEffectiveConfigWithDiagnostics;
  const classify = options.classifyAction ?? defaultClassifyAction;
  const saveClassifierModel = options.saveClassifierModel ??
    writeGlobalClassifierModel;

  return function piAutomode(pi: ExtensionAPI) {
    let loadResult = loadConfigWithDiagnostics(process.cwd());
    let config: EffectiveConfig = loadResult.config;
    let configDiagnostics: string[] = loadResult.diagnostics;
    let state: AutoModeState = {
      checkedActions: 0,
      blockedActions: 0,
      classifierAllowed: 0,
      classifierDenied: 0,
      recentDenials: [],
    };
    let loadedContext = "";

    function effectiveConfig(): EffectiveConfig {
      return {
        ...config,
        enabled: state.enabledOverride ?? config.enabled,
      };
    }

    function persist(): void {
      pi.appendEntry("pi-automode-state", state);
    }

    /**
     * Notify according to the configured notification level.
     * "all" shows everything; "statusOnly" keeps only security-critical
     * notifications (blocks and errors); "none" silences everything. The
     * status line keeps rendering regardless of the notification level.
     */
    function notify(
      ctx: ExtensionContext | ExtensionCommandContext,
      message: string,
      kind: "status" | "safety" = "status",
    ): void {
      if (!ctx.hasUI) return;
      const level = effectiveConfig().notifications;
      if (level === "none") return;
      if (level === "statusOnly" && kind !== "safety") return;
      ctx.ui.notify(message, kind === "safety" ? "warning" : "info");
    }

    function updateUi(ctx: ExtensionContext): void {
      if (!ctx.hasUI) return;
      const cfg = effectiveConfig();
      const text = statusLine(cfg, state);
      ctx.ui.setStatus(
        "pi-automode",
        cfg.enabled
          ? ctx.ui.theme.fg("accent", text)
          : ctx.ui.theme.fg("dim", text),
      );
    }

    function block(
      ctx: ExtensionContext,
      denial: DenialRecord,
      logCtx: LogCtx,
    ): { block: true; reason: string } {
      state.blockedActions += 1;
      state.lastDecision = "block";
      state.lastReason = denial.reason;
      pushDenial(state, denial);
      persist();
      updateUi(ctx);
      if (logCtx.logger.enabled) {
        logCtx.logger.append({
          type: "decision",
          ts: new Date().toISOString(),
          decisionId: logCtx.decisionId,
          sessionId: ctx.sessionManager.getSessionId?.(),
          cwd: ctx.cwd,
          tool: denial.toolName,
          summary: denial.action,
          kind: denial.kind,
          outcome: "block",
          reason: denial.reason,
          classifierModel: logCtx.classifierModel,
          reasoning: logCtx.reasoning,
        });
      }
      if (ctx.hasUI) {
        notify(
          ctx,
          `Auto mode blocked ${denial.toolName}: ${denial.reason}`,
          "safety",
        );
      }
      return { block: true, reason: `[pi-automode] ${denial.reason}` };
    }

    function allow(
      ctx: ExtensionContext,
      kind: DecisionKind,
      reason: string,
      toolName: string,
      summary: string,
      logCtx: LogCtx,
    ): undefined {
      state.lastDecision = "allow";
      state.lastReason = reason;
      persist();
      updateUi(ctx);
      if (logCtx.logger.enabled) {
        logCtx.logger.append({
          type: "decision",
          ts: new Date().toISOString(),
          decisionId: logCtx.decisionId,
          sessionId: ctx.sessionManager.getSessionId?.(),
          cwd: ctx.cwd,
          tool: toolName,
          summary,
          kind,
          outcome: "allow",
          reason,
          classifierModel: logCtx.classifierModel,
          reasoning: logCtx.reasoning,
        });
      }
      return undefined;
    }

    pi.on("session_start", (_event, ctx) => {
      loadResult = loadConfigWithDiagnostics(ctx.cwd);
      config = loadResult.config;
      configDiagnostics = loadResult.diagnostics;
      state = restoreState(ctx);
      updateUi(ctx);
    });

    pi.on("before_agent_start", (event) => {
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;
      loadedContext = loadedContextFromSystemPromptOptions(
        event.systemPromptOptions,
      );
      return { systemPrompt: `${event.systemPrompt}\n\n${AUTO_MODE_GUIDANCE}` };
    });

    pi.on("tool_call", async (event, ctx) => {
      // Enforcement order:
      // 1. permission deny/ask rules,
      // 2. deterministic hard-deny checks that never consult the model,
      // 3. read-only built-in fast path (skipped when classifyReadOnlyTools is set),
      // 4. classifier for every remaining action, fail-closed on setup/parse errors.
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;
      if (ctx.signal?.aborted) return { block: true, reason: "Cancelled" };

      const input = event.input as Record<string, unknown>;
      const summary = actionSummary(event.toolName, input);
      state.checkedActions += 1;
      const logCtx: LogCtx = {
        logger: createLogger({
          enabled: cfg.log.enabled,
          classifierIo: cfg.log.classifierIo,
          sessionFile: ctx.sessionManager.getSessionFile?.(),
          sessionDir: ctx.sessionManager.getSessionDir?.() ?? ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId?.() ?? "unknown",
        }),
        decisionId: newDecisionId(),
        classifierModel: cfg.classifierModel,
        reasoning: classifierReasoningForConfig(cfg.classifierReasoningLevel),
      };

      for (const pattern of cfg.permissionDeny) {
        if (matchesToolPattern(pattern, event.toolName, input, ctx.cwd)) {
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Blocked by permissions.deny: ${pattern.raw}`,
            action: summary,
            kind: "permissions.deny",
          }, logCtx);
        }
      }

      for (const pattern of cfg.permissionAsk) {
        if (!matchesToolPattern(pattern, event.toolName, input, ctx.cwd)) {
          continue;
        }
        if (!ctx.hasUI) {
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason:
              `Matched permissions.ask (${pattern.raw}) but no UI is available`,
            action: summary,
            kind: "permissions.ask",
          }, logCtx);
        }
        const allowed = await ctx.ui.confirm(
          "Auto mode permission ask",
          `Rule: ${pattern.raw}\n\nAction:\n${summary}\n\nAllow this action to continue to auto-mode classification?`,
          { signal: ctx.signal },
        );
        if (!allowed) {
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Declined permissions.ask: ${pattern.raw}`,
            action: summary,
            kind: "permissions.ask",
          }, logCtx);
        }
      }

      const deterministicReason = deterministicHardDeny(
        event.toolName,
        input,
        ctx.cwd,
      );
      if (deterministicReason) {
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: deterministicReason,
          action: summary,
          kind: "deterministic-hard-deny",
        }, logCtx);
      }

      // Deterministic path gate for file tools.
      //
      // `deniedPaths` always applies: a matching path is hard-denied before any
      // classifier or fast path, so secrets and system dirs never reach the
      // model. `allowInsideWorkingDirectory` adds a deterministic silent-allow
      // tier for file tools whose resolved path is inside the working
      // directory, and routes outside-CWD file access to the classifier
      // (bypassing the read-only fast path so reads outside the tree are
      // reviewed too).
      //
      // The gate is skipped entirely when both features are off, so the
      // default configuration costs no extra filesystem calls.
      let readOnlyFastPath =
        !cfg.classifyReadOnlyTools && READ_ONLY_TOOLS.has(event.toolName);
      if (
        (cfg.deniedPaths.length > 0 || cfg.allowInsideWorkingDirectory) &&
        PATH_BEARING_TOOLS.has(event.toolName)
      ) {
        const inputPath = extractInputPath(event.toolName, input);
        if (inputPath !== undefined) {
          const expanded = expandHomePattern(inputPath);
          const resolved = resolveInputPath(ctx.cwd, expanded) ?? expanded;
          const policyPath = resolvePathForPolicy(resolved) ?? resolved;
          const denied =
            cfg.deniedPaths.length > 0 &&
            (matchesDeniedPath(resolved, cfg.deniedPaths) ||
              matchesDeniedPath(policyPath, cfg.deniedPaths));
          if (denied) {
            return block(ctx, {
              timestamp: Date.now(),
              toolName: event.toolName,
              reason: `Path denied by policy: ${policyPath}`,
              action: summary,
              kind: "deterministic-path-deny",
            }, logCtx);
          }
          if (cfg.allowInsideWorkingDirectory) {
            const policyCwd = resolvePathForPolicy(ctx.cwd) ?? ctx.cwd;
            if (isInside(policyPath, policyCwd)) {
              // Protected in-tree writes must still reach the classifier;
              // otherwise the allow tier bypasses the protected-path policy
              // for sensitive repository content such as .git/hooks/*, .pi/*,
              // .husky/*, or .gitignore.
              if (
                (event.toolName === "write" || event.toolName === "edit") &&
                isProtectedPath(policyPath, policyCwd, cfg.protectedPaths)
              ) {
                readOnlyFastPath = false;
              } else {
                return allow(
                  ctx,
                  "inside-working-directory",
                  `Path inside working directory: ${policyPath}`,
                  event.toolName,
                  summary,
                  logCtx,
                );
              }
            }
            // Outside the working directory: the read-only fast path must not
            // apply; the classifier reviews this call.
            readOnlyFastPath = false;
          }
        }
      }

      if (readOnlyFastPath) {
        return allow(
          ctx,
          "read-only",
          `Read-only built-in tool: ${event.toolName}`,
          event.toolName,
          summary,
          logCtx,
        );
      }

      // Deterministic bash fast path: a curated pattern list of read-only
      // commands skips the classifier entirely. Deterministic hard-deny and
      // permission rules already ran above, so a command like
      // `git status && rm -rf /` is still blocked before reaching this tier
      // (hard-deny parses every shell segment).
      if (event.toolName === "bash" && cfg.bashFastPath.length > 0) {
        const matched = cfg.bashFastPath.some((pattern) =>
          matchesToolPattern(pattern, event.toolName, input, ctx.cwd),
        );
        if (matched) {
          return allow(
            ctx,
            "bash-fast-path",
            `Bash fast-path pattern matched: ${
              typeof input.command === "string" ? input.command : summary
            }`,
            event.toolName,
            summary,
            logCtx,
          );
        }
      }

      const decision = await classify(ctx, cfg, summary, loadedContext);
      logClassifierIo(decision, logCtx);
      if (decision.decision === "allow") {
        state.classifierAllowed += 1;
        return allow(
          ctx,
          "classifier",
          decision.reason,
          event.toolName,
          summary,
          logCtx,
        );
      }

      state.classifierDenied += 1;
      return block(ctx, {
        timestamp: Date.now(),
        toolName: event.toolName,
        reason: decision.reason,
        action: summary,
        kind: "classifier",
      }, logCtx);
    });

    async function handleAutomodeCommand(
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const [command = "status", ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const remainder = rest.join(" ").trim();

      if (command === "status") {
        notify(ctx, statusText(effectiveConfig(), state), "safety");
        return;
      }
      if (command === "on") {
        state.enabledOverride = true;
        persist();
        updateUi(ctx);
        notify(ctx, "pi-automode enabled for this session");
        return;
      }
      if (command === "off") {
        state.enabledOverride = false;
        persist();
        updateUi(ctx);
        notify(ctx, "pi-automode disabled for this session");
        return;
      }
      if (command === "reload") {
        loadResult = loadConfigWithDiagnostics(ctx.cwd);
        config = loadResult.config;
        configDiagnostics = loadResult.diagnostics;
        persist();
        updateUi(ctx);
        notify(
          ctx,
          "pi-automode config reloaded" +
            (configDiagnostics.length > 0 ? " (with diagnostics)" : ""),
        );
        if (configDiagnostics.length > 0) {
          notify(ctx, configDiagnostics.join("\n"), "safety");
        }
        return;
      }
      if (command === "reset") {
        state = {
          checkedActions: 0,
          blockedActions: 0,
          classifierAllowed: 0,
          classifierDenied: 0,
          recentDenials: [],
          enabledOverride: state.enabledOverride,
        };
        persist();
        updateUi(ctx);
        notify(ctx, "pi-automode counters reset");
        return;
      }
      if (command === "defaults") {
        notify(
          ctx,
          safeJson(
            {
              environment: DEFAULT_ENVIRONMENT,
              allow: DEFAULT_ALLOW,
              protectedPaths: DEFAULT_PROTECTED_PATHS,
              soft_deny: DEFAULT_SOFT_DENY,
              hard_deny: DEFAULT_HARD_DENY,
            },
            12000,
          ),
          "safety",
        );
        return;
      }
      if (command === "config") {
        const logFile = resolveLogPath(
          ctx.sessionManager.getSessionFile?.(),
          ctx.sessionManager.getSessionDir?.() ?? ctx.cwd,
          ctx.sessionManager.getSessionId?.() ?? "unknown",
        );
        notify(
          ctx,
          safeJson(
            {
              config: effectiveConfig(),
              logFile,
              diagnostics: configDiagnostics,
            },
            16000,
          ),
          "safety",
        );
        return;
      }
      if (command === "denials") {
        notify(ctx, formatDenials(state), "safety");
        return;
      }
      if (command === "model") {
        const selected = remainder || await promptForClassifierModel(
          ctx,
          effectiveConfig().classifierModel,
        );
        if (!selected) {
          notify(ctx, "Classifier model unchanged");
          return;
        }
        const parsed = parseModelSpec(selected);
        const model = parsed
          ? ctx.modelRegistry.find(parsed.provider, parsed.id)
          : undefined;
        if (!model) {
          notify(ctx, `Model not found: ${selected}`, "safety");
          return;
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          notify(ctx, auth.error, "safety");
          return;
        }
        const modelSpec = formatModelSpec(model);
        try {
          saveClassifierModel(modelSpec);
        } catch (error) {
          notify(
            ctx,
            `Failed to save classifier model: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "safety",
          );
          return;
        }
        loadResult = loadConfigWithDiagnostics(ctx.cwd);
        config = loadResult.config;
        configDiagnostics = loadResult.diagnostics;
        persist();
        updateUi(ctx);
        const active = effectiveConfig().classifierModel ??
          "current session model";
        notify(
          ctx,
          active === modelSpec
            ? `pi-automode classifier saved globally: ${modelSpec}`
            : `pi-automode classifier saved globally: ${modelSpec}; current config uses ${active}`,
        );
        return;
      }

      notify(
        ctx,
        "Usage: /automode [status|on|off|reload|reset|defaults|config|denials|model [provider/id]]",
        "safety",
      );
    }

    pi.registerCommand("automode", {
      description:
        "Control pi-automode: status, on, off, reload, reset, defaults, config, denials, model",
      handler: handleAutomodeCommand,
    });

    pi.registerCommand("auto-mode", {
      description: "Alias for /automode",
      handler: handleAutomodeCommand,
    });
  };
}
