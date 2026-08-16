/**
 * Reload command — /memory-reload re-reads the LLM model override settings
 * from hermes-memory-config.json (and PI_HERMES_* env vars) without a pi
 * restart.
 *
 * Fork addition. Full config (limits, paths, detectors) is captured in
 * factory-time closures and still requires a restart; this command targets
 * the model override because that is what users want to hot-swap.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../types.js";
import { loadConfig } from "../config.js";

/** Mutable shared LLM config consumed by review/consolidation/child-process calls. */
export type LlmConfigRef = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

export function registerReloadCommand(
  pi: ExtensionAPI,
  llmConfigRef: LlmConfigRef,
): void {
  pi.registerCommand("memory-reload", {
    description: "Reload LLM model override config (hermes-memory-config.json + PI_HERMES_* env)",
    handler: async (_args, ctx) => {
      const before = `${llmConfigRef.llmModelOverride ?? "(session model)"} / ${llmConfigRef.llmThinkingOverride ?? "(default)"}`;
      const fresh = loadConfig();
      llmConfigRef.llmModelOverride = fresh.llmModelOverride;
      llmConfigRef.llmThinkingOverride = fresh.llmThinkingOverride;
      const after = `${llmConfigRef.llmModelOverride ?? "(session model)"} / ${llmConfigRef.llmThinkingOverride ?? "(default)"}`;
      ctx.ui.notify(
        before === after
          ? `pi-hermes-memory LLM config unchanged: ${after}`
          : `pi-hermes-memory LLM config reloaded: ${before} → ${after}`,
        "info",
      );
    },
  });
}
