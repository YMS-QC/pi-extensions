/**
 * pi SDK adapter boundary
 * Zones: pi agent sdk boundary, shared adapters
 * Owns direct pi SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
  type AgentEndEvent,
  type AgentSettledEvent,
  type AgentStartEvent,
  type BeforeAgentStartEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SlashCommandInfo,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  AssistantMessageEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SlashCommandInfo,
};

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface PiSettingsManager {
  reload: () => Promise<void>;
  flush: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
  setEnabledModels: (patterns: string[] | undefined) => void;
}

export type PiSlashCommandInfo = SlashCommandInfo;
export type PiRunMode = "tui" | "rpc" | "json" | "print";

function isPiRunMode(value: unknown): value is PiRunMode {
  return (
    value === "tui" || value === "rpc" || value === "json" || value === "print"
  );
}

const STALE_EXTENSION_CONTEXT_MESSAGE_PREFIX =
  "This extension ctx is stale";

export function isExtensionContextStaleError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(STALE_EXTENSION_CONTEXT_MESSAGE_PREFIX)
  );
}

/**
 * True when the captured ctx was invalidated by session replacement or reload.
 * Re-throws unrelated errors so genuine failures stay visible.
 */
export function isExtensionContextStale(ctx: unknown): boolean {
  const probe = (ctx as { isIdle?: unknown } | undefined)?.isIdle;
  if (typeof probe !== "function") return false;
  try {
    void (probe as () => boolean).call(ctx);
    return false;
  } catch (error) {
    return isExtensionContextStaleError(error);
  }
}

/**
 * Pi invalidates captured extension contexts after newSession/fork/switchSession/
 * reload; any member access then throws. Reads through these helpers degrade to
 * the given fallback instead of throwing from timers/event handlers.
 */
function readExtensionContext<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    if (isExtensionContextStaleError(error)) return fallback;
    throw error;
  }
}

export function getExtensionContextMode(ctx: unknown): PiRunMode | undefined {
  const mode = readExtensionContext(
    () =>
      typeof ctx === "object" && ctx !== null
        ? (ctx as { mode?: unknown }).mode
        : undefined,
    undefined,
  );
  return isPiRunMode(mode) ? mode : undefined;
}

export function isExtensionContextPassiveRunMode(ctx: unknown): boolean {
  const mode = getExtensionContextMode(ctx);
  return mode === "print" || mode === "json";
}

export function canStartPollingInExtensionContext(ctx: unknown): boolean {
  return !isExtensionContextPassiveRunMode(ctx);
}

export function formatPollingStartBlockedByRunMode(ctx: unknown): string {
  const mode = getExtensionContextMode(ctx);
  return mode
    ? `Telegram polling is unavailable in Pi ${mode} mode. Use /telegram-connect from a long-lived Pi session.`
    : "Telegram polling is unavailable in this Pi run mode.";
}

export function getSessionCompactionReason(
  event: unknown,
): "manual" | "threshold" | "overflow" | "unknown" {
  const reason =
    event && typeof event === "object" && "reason" in event
      ? (event as { reason?: unknown }).reason
      : undefined;
  return reason === "manual" || reason === "threshold" || reason === "overflow"
    ? reason
    : "unknown";
}

export interface PiExtensionApiRuntimePorts {
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  exec: ExtensionAPI["exec"];
  getCommands: ExtensionAPI["getCommands"];
  getThinkingLevel: ExtensionAPI["getThinkingLevel"];
  setThinkingLevel: ExtensionAPI["setThinkingLevel"];
  getActiveTools: ExtensionAPI["getActiveTools"];
  setActiveTools: ExtensionAPI["setActiveTools"];
  setModel: ExtensionAPI["setModel"];
}

export function createExtensionApiRuntimePorts(
  api: Pick<
    ExtensionAPI,
    | "sendUserMessage"
    | "exec"
    | "getCommands"
    | "getThinkingLevel"
    | "setThinkingLevel"
    | "getActiveTools"
    | "setActiveTools"
    | "setModel"
  >,
): PiExtensionApiRuntimePorts {
  return {
    sendUserMessage: (content, options) =>
      api.sendUserMessage(content, options),
    exec: (command, args, options) => api.exec(command, args, options),
    getCommands: () => api.getCommands(),
    getThinkingLevel: () => api.getThinkingLevel(),
    setThinkingLevel: (level) => api.setThinkingLevel(level),
    getActiveTools: () => api.getActiveTools(),
    setActiveTools: (names) => api.setActiveTools(names),
    setModel: (model) => api.setModel(model),
  };
}

type PiSettingsManagerFactory = {
  create: (cwd: string) => unknown | PromiseLike<unknown>;
};

type HostSettingsManager = {
  reload?: () => void | PromiseLike<void>;
  flush?: () => void | PromiseLike<void>;
  getEnabledModels?: () => unknown;
  setEnabledModels?: (patterns: string[] | undefined) => void;
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
};

function readEnabledModels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return [...value];
  }
  throw new TypeError("Host settings enabledModels must be a string array or undefined.");
}

export function normalizeSettingsManager(manager: unknown): PiSettingsManager {
  if (typeof manager !== "object" || manager === null) {
    throw new TypeError("Host settings manager must be an object.");
  }
  const host = manager as HostSettingsManager;
  if (typeof host.flush !== "function") {
    throw new TypeError("Host settings manager must provide flush().");
  }
  const read = typeof host.getEnabledModels === "function"
    ? () => host.getEnabledModels!.call(host)
    : typeof host.get === "function"
      ? () => host.get!.call(host, "enabledModels")
      : undefined;
  const write = typeof host.setEnabledModels === "function"
    ? (patterns: string[] | undefined) =>
        host.setEnabledModels!.call(host, patterns)
    : typeof host.set === "function"
      ? (patterns: string[] | undefined) =>
          host.set!.call(host, "enabledModels", patterns ?? [])
      : undefined;
  if (!read || !write) {
    throw new TypeError(
      "Host settings manager must provide enabled-model read and write capabilities.",
    );
  }
  return {
    reload: async () => {
      await host.reload?.call(host);
    },
    flush: async () => {
      await host.flush!.call(host);
    },
    getEnabledModels: () => readEnabledModels(read()),
    setEnabledModels: write,
  };
}

export async function createSettingsManager(
  cwd: string,
): Promise<PiSettingsManager> {
  // Pi returns its legacy settings surface synchronously. Compatible hosts may
  // resolve a generic settings service asynchronously; normalize both once at
  // the SDK boundary instead of leaking host distinctions into menu domains.
  const factory = SettingsManager as unknown as PiSettingsManagerFactory;
  return normalizeSettingsManager(await factory.create(cwd));
}

export function createScopedModelPatternPersister(deps: {
  createSettingsManager: (
    cwd: string,
  ) => PiSettingsManager | PromiseLike<PiSettingsManager>;
  clearCachedModelMenuInputs: () => void;
}): (patterns: string[], ctx: ExtensionContext) => Promise<void> {
  return async (patterns, ctx) => {
    const settingsManager = await deps.createSettingsManager(ctx.cwd);
    settingsManager.setEnabledModels(
      patterns.length > 0 ? patterns : undefined,
    );
    await settingsManager.flush();
    deps.clearCachedModelMenuInputs();
  };
}

export function getExtensionContextModel(
  ctx: ExtensionContext,
): ExtensionContext["model"] {
  return readExtensionContext(() => ctx.model, undefined);
}

export function getExtensionContextCwd(ctx: ExtensionContext): string {
  return readExtensionContext(() => ctx.cwd, "");
}

export function isExtensionContextIdle(ctx: ExtensionContext): boolean {
  return readExtensionContext(() => ctx.isIdle(), false);
}

export function hasExtensionContextPendingMessages(
  ctx: ExtensionContext,
): boolean {
  return readExtensionContext(() => ctx.hasPendingMessages(), false);
}

export function compactExtensionContext(
  ctx: ExtensionContext,
  callbacks: Parameters<ExtensionContext["compact"]>[0],
): ReturnType<ExtensionContext["compact"]> {
  return ctx.compact(callbacks);
}
