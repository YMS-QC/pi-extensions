import test from "node:test";
import assert from "node:assert/strict";
import type { ToolPattern } from "../extensions/auto-mode/types.ts";
import { parseToolPattern } from "../extensions/auto-mode/permissions.ts";
import type { EffectiveConfig } from "../extensions/auto-mode/types.ts";
import { baseConfig, setupHookTest } from "./test-helpers.ts";

/**
 * Fork-only guardrail features that do not exist upstream:
 * the deterministic bash fast-path tier and the classifier decision cache.
 * Kept in a dedicated file so upstream test-suite splits merge cleanly.
 */

const parseToolPatternList = (...entries: string[]) =>
	entries
		.map((entry) => parseToolPattern(entry))
		.filter((pattern): pattern is ToolPattern => pattern !== undefined);

/** Layer fork-only config fields on top of the upstream base config. */
function forkConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	return baseConfig({
		bashFastPath: parseToolPatternList(),
		decisionCache: { enabled: false, ttlMs: 300_000, maxEntries: 256 },
		...overrides,
	});
}

test("bash fast-path allows matching read-only commands without classifier", async () => {
	const harness = await setupHookTest({
		config: forkConfig({
			bashFastPath: parseToolPatternList(
				"bash(git status*)",
				"bash(git diff*)",
				"bash(ls)",
			),
		}),
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "git status" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 0);
});

test("bash fast-path patterns are configurable and replaceable", async () => {
	const harness = await setupHookTest({
		config: forkConfig({
			bashFastPath: parseToolPatternList("bash(git status)"),
		}),
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }),
	});

	const allowed = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "git status" },
	}, harness.ctx);
	assert.equal(allowed, undefined);
	assert.equal(harness.classifierCalls, 0);

	const classified = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "git diff" },
	}, harness.ctx);
	assert.notEqual(classified, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("bash fast-path never bypasses deterministic hard-deny", async () => {
	const harness = await setupHookTest({
		config: forkConfig({
			bashFastPath: parseToolPatternList("bash(git status && rm -rf /)", "bash(rm -rf /*)"),
		}),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "git status && rm -rf /" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /hard-denied/);
	assert.equal(harness.classifierCalls, 0);
});

test("decision cache reuses an identical recent classifier decision", async () => {
	let calls = 0;
	const harness = await setupHookTest({
		config: forkConfig({
			decisionCache: { enabled: true, ttlMs: 300_000, maxEntries: 256 },
		}),
		classifier: async () => {
			calls += 1;
			return { decision: "block", tier: "soft_deny", reason: `mock block ${calls}` };
		},
	});

	const first = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness.ctx) as { block?: boolean; reason?: string };
	assert.equal(first.block, true);
	assert.match(first.reason ?? "", /mock block 1/);

	const second = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness.ctx) as { block?: boolean; reason?: string };
	assert.equal(second.block, true);
	assert.match(second.reason ?? "", /cached \(\d+s ago\): mock block 1/);
	assert.equal(harness.classifierCalls, 1);
});

test("decision cache is off by default and respects different commands", async () => {
	const harness = await setupHookTest({
		config: forkConfig(),
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "mock allow" }),
	});

	await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness.ctx);
	await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness.ctx);
	assert.equal(harness.classifierCalls, 2, "no cache by default");

	const harness2 = await setupHookTest({
		config: forkConfig({
			decisionCache: { enabled: true, ttlMs: 300_000, maxEntries: 256 },
		}),
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "mock allow" }),
	});
	await harness2.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness2.ctx);
	const r = await harness2.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish --tag next" },
	}, harness2.ctx);
	assert.equal(r, undefined);
	assert.equal(harness2.classifierCalls, 2, "different commands do not share cache entries");
});
