import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_ALLOW,
	DEFAULT_LOG_CONFIG,
	DEFAULT_PROTECTED_PATHS,
	DEFAULT_SOFT_DENY,
	PI_GLOBAL_SETTINGS,
	buildEffectiveConfigFromSources,
	classifyWithRetry,
	createLogger,
	createPiAutomode,
	deterministicHardDeny,
	matchesToolPattern,
	newDecisionId,
	parseClassifierDecision,
	parseToolPattern,
	resolveLogPath,
	statusLine,
	validateSettingsFile,
	writeGlobalClassifierModel,
	type AutoModeState,
	type ClassificationDecision,
	type ClassifierIoAttempt,
	type ClassifyAction,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const entries: any[] = [];

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
	} as any;

	return {
		pi,
		entries,
		commands,
		async emit(event: string, payload: any, ctx: any) {
			let lastResult: unknown;
			for (const handler of handlers.get(event) ?? []) {
				lastResult = await handler(payload, ctx);
				if ((lastResult as { block?: boolean } | undefined)?.block) return lastResult;
			}
			return lastResult;
		},
	};
}

function createFakeCtx(entries: any[] = [], overrides: Record<string, unknown> = {}) {
	const { sessionFile, ...rest } = overrides;
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const widgets: Array<{ key: string; content: string[] | undefined }> = [];

	return {
		cwd: "/tmp/project",
		mode: "tui",
		hasUI: true,
		signal: undefined,
		model: { provider: "test", id: "classifier" },
		modelRegistry: {
			find() {
				return { provider: "test", id: "classifier" };
			},
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "test-key" };
			},
		},
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => [],
			getSessionFile: () => sessionFile as string | undefined,
			getSessionDir: () => sessionFile ? dirname(sessionFile) : "/tmp",
			getSessionId: () => "test-session",
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
			setWidget(key: string, content: string[] | undefined) {
				widgets.push({ key, content });
			},
			async confirm() {
				return true;
			},
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
				bold(text: string) {
					return text;
				},
			},
		},
		statuses,
		notifications,
		isProjectTrusted: () => true,
		getSystemPrompt: () => "",
		...rest,
	};
}

function baseConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	return {
		enabled: true,
		maxTranscriptLines: 80,
		environment: [],
		allow: [],
		protectedPaths: [...DEFAULT_PROTECTED_PATHS],
		softDeny: [],
		hardDeny: [],
		permissionDeny: [],
		permissionAsk: [],
		log: { ...DEFAULT_LOG_CONFIG },
		...overrides,
	};
}

function baseState(overrides: Partial<AutoModeState> = {}): AutoModeState {
	return {
		checkedActions: 0,
		blockedActions: 0,
		classifierAllowed: 0,
		classifierDenied: 0,
		recentDenials: [],
		...overrides,
	};
}

async function setupHookTest(options: {
	config?: EffectiveConfig;
	classifier?: () => Promise<ClassificationDecision>;
	ctx?: ReturnType<typeof createFakeCtx>;
} = {}) {
	const fake = createFakePi();
	let classifierCalls = 0;
	const classifier = options.classifier ?? (async () => ({ decision: "allow", tier: "none", reason: "test allow" }));
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig(),
		classifyAction: async () => {
			classifierCalls += 1;
			return classifier();
		},
	})(fake.pi);
	const ctx = options.ctx ?? createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return { ...fake, ctx, get classifierCalls() { return classifierCalls; } };
}

test("global config path uses Pi agent config directory", () => {
	assert.match(PI_GLOBAL_SETTINGS[0] ?? "", /\.pi\/agent\/automode\.json$/);
});

test("project shared Pi settings can add permissions but cannot weaken autoMode", () => {
	const config = buildEffectiveConfigFromSources({
		projectSharedSettings: [
			{
				autoMode: {
					classifierModel: "shared/model",
					allow: ["checked-in repo tries to allow everything"],
					hard_deny: ["checked-in repo tries to replace hard denies"],
				},
				permissions: {
					deny: ["bash(git push --force*)"],
				},
			},
		],
	});

	assert.equal(config.classifierModel, undefined);
	assert.equal(config.allow.includes("checked-in repo tries to allow everything"), false);
	assert.equal(config.hardDeny.includes("checked-in repo tries to replace hard denies"), false);
	assert.equal(config.permissionDeny.length, 1);
	assert.equal(config.permissionDeny[0]?.raw, "bash(git push --force*)");
});

test("project-local classifier model overrides global classifier model", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierModel: "global/model" } }],
		projectLocalSettings: [{ autoMode: { classifierModel: "project/model" } }],
	});

	assert.equal(config.classifierModel, "project/model");
});

test("rule lists replace defaults only for their own section when $defaults is omitted", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [
			{
				autoMode: {
					allow: ["local only"],
				},
			},
		],
	});

	assert.deepEqual(config.allow, ["local only"]);
	assert.deepEqual(config.softDeny, DEFAULT_SOFT_DENY);
});

test("rule lists combine across configurable scopes when $defaults is present", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { allow: ["$defaults", "global allow"] } }],
		projectLocalSettings: [{ autoMode: { allow: ["$defaults", "local allow"] } }],
	});

	assert.equal(DEFAULT_ALLOW.every((rule) => config.allow.includes(rule)), true);
	assert.equal(config.allow.includes("global allow"), true);
	assert.equal(config.allow.includes("local allow"), true);
});

test("permission patterns keep argument scope instead of flattening to a tool allow", () => {
	const pattern = parseToolPattern("bash(git status*)");
	assert.ok(pattern);
	assert.equal(matchesToolPattern(pattern, "bash", { command: "git status --short" }, process.cwd()), true);
	assert.equal(matchesToolPattern(pattern, "bash", { command: "git push --force" }, process.cwd()), false);

	const capitalized = parseToolPattern("Bash(git status*)");
	assert.ok(capitalized);
	assert.equal(matchesToolPattern(capitalized, "bash", { command: "git status --short" }, process.cwd()), true);
});

test("deterministic hard deny catches safety-control edits", () => {
	const cwd = "/tmp/project";
	assert.match(
		deterministicHardDeny("write", { path: ".pi/automode.local.json" }, cwd) ?? "",
		/safety-control/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "echo test >> ~/.zshrc" }, cwd) ?? "",
		/shell profile/,
	);
});

test("deterministic hard deny catches TLS weakening and authorized_keys writes", () => {
	assert.match(
		deterministicHardDeny("bash", { command: "git config --global http.sslVerify false" }, process.cwd()) ?? "",
		/TLS/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "cat key.pub >> ~/.ssh/authorized_keys" }, process.cwd()) ?? "",
		/authorized_keys/,
	);
});

test("shell parsing catches risky suffixes, redirects, and quoted HOME targets", () => {
	assert.match(
		deterministicHardDeny("bash", { command: "echo safe && git config --global http.sslVerify false" }, process.cwd()) ?? "",
		/TLS/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "printf test > ~/.zshrc" }, process.cwd()) ?? "",
		/shell profile/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: 'echo key > "$HOME/.ssh/authorized_keys"' }, process.cwd()) ?? "",
		/authorized_keys/,
	);
	assert.match(
		deterministicHardDeny("bash", { command: "echo nope | tee .pi/automode.local.json" }, "/tmp/project") ?? "",
		/safety-control/,
	);
});

test("writeGlobalClassifierModel preserves global automode settings", () => {
	const tmpDir = mkdtempSync(join(os.tmpdir(), "pi-automode-config-"));
	try {
		const path = join(tmpDir, ".pi", "agent", "automode.json");
		writeGlobalClassifierModel("test/first", path);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			autoMode: { classifierModel: "test/first" },
		});

		writeFileSync(
			path,
			JSON.stringify({
				autoMode: { enabled: false, allow: ["$defaults", "ok"] },
				permissions: { deny: ["bash(rm -rf *)"] },
			}),
		);
		writeGlobalClassifierModel("test/second", path);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
			autoMode: {
				enabled: false,
				allow: ["$defaults", "ok"],
				classifierModel: "test/second",
			},
			permissions: { deny: ["bash(rm -rf *)"] },
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("/automode model saves the selected classifier globally", async () => {
	const fake = createFakePi();
	let saved: string | undefined;
	createPiAutomode({
		loadConfig: () => baseConfig(saved ? { classifierModel: saved } : {}),
		saveClassifierModel: (classifierModel) => {
			saved = classifierModel;
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);

	await fake.commands.get("automode")?.handler("model test/classifier", ctx);

	assert.equal(saved, "test/classifier");
});

test("config validation reports unknown keys, wrong types, and missing defaults", () => {
	const diagnostics = validateSettingsFile({
		unknown: true,
		autoMode: {
			enabled: "yes",
			allow: ["custom allow"],
			hard_deny: [42],
			mystery: [],
		} as any,
		permissions: {
			deny: "Bash(*)",
			maybe: [],
		} as any,
	} as any, "test-config");

	assert.equal(diagnostics.some((line) => line.includes("unknown top-level key unknown")), true);
	assert.equal(diagnostics.some((line) => line.includes("autoMode.enabled must be a boolean")), true);
	assert.equal(diagnostics.some((line) => line.includes('autoMode.allow omits "$defaults"')), true);
	assert.equal(diagnostics.some((line) => line.includes("autoMode.hard_deny[0]")), true);
	assert.equal(diagnostics.some((line) => line.includes("unknown permissions key maybe")), true);
	assert.equal(diagnostics.some((line) => line.includes("permissions.deny must be an array")), true);
});

test("classifier JSON parser accepts valid decisions and rejects invalid output", () => {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: '{"decision":"block","tier":"hard_deny","reason":"secret exfiltration"}' }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} satisfies AssistantMessage;

	assert.deepEqual(parseClassifierDecision(message), {
		decision: "block",
		tier: "hard_deny",
		reason: "secret exfiltration",
	});

	assert.equal(
		parseClassifierDecision({ ...message, content: [{ type: "text", text: "ALLOW because I said so" }] }),
		undefined,
	);
});

function assistantWith(text: string, stopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

const VALID_ALLOW = '{"decision":"allow","tier":"allow","reason":"read-only"}';
const GARBAGE = "and I'm ready to go. I'll start by listing the ability to ability to ability to";

function fakeComplete(responses: AssistantMessage[]) {
	const calls: Array<{ maxTokens: number; temperature?: number }> = [];
	let i = 0;
	const fn = async (
		_model: unknown,
		_options: unknown,
		callOptions: { maxTokens: number; temperature?: number },
	): Promise<AssistantMessage> => {
		calls.push({ ...callOptions });
		const res = responses[i];
		i += 1;
		return res;
	};
	return { fn: fn as never, calls };
}

test("classifyWithRetry returns a valid decision on the first attempt without retrying", async () => {
	const { fn, calls } = fakeComplete([assistantWith(VALID_ALLOW)]);
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
	);
	assert.equal(decision.decision, "allow");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.maxTokens, 1200);
	assert.equal(Object.hasOwn(calls[0] ?? {}, "temperature"), false);
});

test("classifyWithRetry forwards an explicitly configured temperature", async () => {
	const { fn, calls } = fakeComplete([assistantWith(VALID_ALLOW)]);
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
		{ temperature: 0 },
	);
	assert.equal(decision.decision, "allow");
	assert.equal(calls[0]?.temperature, 0);
});

test("classifyWithRetry recovers when the first response is garbage and the second is valid", async () => {
	const { fn, calls } = fakeComplete([assistantWith(GARBAGE), assistantWith(VALID_ALLOW)]);
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
	);
	assert.equal(decision.decision, "allow");
	assert.equal(calls.length, 2);
});

test("classifyWithRetry recovers from a truncated (stopReason length) response on retry", async () => {
	const { fn, calls } = fakeComplete([
		assistantWith(GARBAGE, "length"),
		assistantWith(VALID_ALLOW),
	]);
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
	);
	assert.equal(decision.decision, "allow");
	assert.equal(calls.length, 2);
});

test("classifyWithRetry fails closed when every attempt returns unparseable output", async () => {
	const { fn, calls } = fakeComplete([assistantWith(GARBAGE, "length"), assistantWith(GARBAGE)]);
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
	);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /fails closed/);
	assert.equal(calls.length, 2);
});

test("classifyWithRetry fails closed immediately without retrying when complete throws", async () => {
	let calls = 0;
	const fn = async () => {
		calls += 1;
		throw new Error("network down");
	};
	const decision = await classifyWithRetry(
		fn as never,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
	);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /Classifier failed/);
	assert.equal(calls, 1);
});

test("classifyWithRetry surfaces provider-reported errors without retrying", async () => {
	const response = {
		...assistantWith("", "error"),
		errorMessage: "Unsupported parameter: temperature",
	};
	const { fn, calls } = fakeComplete([response, assistantWith(VALID_ALLOW)]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
		{ onAttempt: (attempt) => attempts.push(attempt) },
	);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /Unsupported parameter: temperature/);
	assert.equal(calls.length, 1);
	assert.equal(attempts[0]?.response?.errorMessage, "Unsupported parameter: temperature");
});

test("classifyWithRetry fails closed on an error stopReason with an empty message and valid allow JSON", async () => {
	const response = {
		...assistantWith(VALID_ALLOW, "error"),
		errorMessage: "",
	};
	const { fn, calls } = fakeComplete([response, assistantWith(VALID_ALLOW)]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
		{ onAttempt: (attempt) => attempts.push(attempt) },
	);
	assert.equal(decision.decision, "block");
	assert.match(decision.reason, /Classifier model returned an error response/);
	assert.equal(calls.length, 1);
	assert.equal(attempts[0]?.parsed, undefined);
	assert.equal(attempts[0]?.response?.errorMessage, "");
});

test("tool_call hook blocks permissions.deny before deterministic checks and classifier", async () => {
	const pattern = parseToolPattern("bash(git push --force*)");
	assert.ok(pattern);
	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: [pattern] }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "git push --force origin main" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /permissions\.deny/);
	assert.equal(harness.classifierCalls, 0);
});

test("tool_call hook runs deterministic hard-deny before classifier", async () => {
	const harness = await setupHookTest();

	const result = await harness.emit("tool_call", {
		toolName: "write",
		input: { path: ".pi/automode.local.json", content: "{}" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /safety-control/);
	assert.equal(harness.classifierCalls, 0);
});

test("tool_call hook allows safe read-only tools without classifier", async () => {
	const harness = await setupHookTest();

	const result = await harness.emit("tool_call", {
		toolName: "read",
		input: { path: "README.md" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 0);
});

test("tool_call hook uses classifier mock for non-read-only actions", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /mock block/);
	assert.equal(harness.classifierCalls, 1);
});

test("tool_call hook allows classifier-approved non-read-only actions", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "mock allow" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm test" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("classifier-allowed action increments ca but not ad in statusline", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "mock allow" }),
	});

	await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm test" },
	}, harness.ctx);

	const last = (harness.ctx.statuses as Array<{ key: string; text?: string }>)
		.filter((s) => s.key === "pi-automode")
		.at(-1)?.text;
	assert.match(last ?? "", /ca:1 cd:0/);
});

test("classifier-denied action increments cd but not ca in statusline", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }),
	});

	await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, harness.ctx);

	const last = (harness.ctx.statuses as Array<{ key: string; text?: string }>)
		.filter((s) => s.key === "pi-automode")
		.at(-1)?.text;
	assert.match(last ?? "", /ca:0 cd:1/);
});

test("tool_call hook blocks classifier-needed actions when no classifier is available", async () => {
	const fake = createFakePi();
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	const ctx = createFakeCtx(fake.entries, { model: undefined });
	await fake.emit("session_start", { type: "session_start" }, ctx);

	const result = await fake.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm publish" },
	}, ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /No classifier model/);
});

test("write to protected path goes to classifier", async () => {
	const harness = await setupHookTest({
		config: baseConfig(),
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "approved" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "write",
		input: { path: ".gitignore", content: "node_modules/" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("write to protected path blocked by classifier", async () => {
	const harness = await setupHookTest({
		config: baseConfig(),
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "no" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "write",
		input: { path: ".vscode/settings.json", content: "{}" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /no/);
	assert.equal(harness.classifierCalls, 1);
});

test("edit to protected path goes to classifier", async () => {
	const harness = await setupHookTest({
		config: baseConfig(),
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "ok" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "edit",
		input: { path: ".bashrc", oldText: "old", newText: "new" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("read-only tools bypass protected path check", async () => {
	const harness = await setupHookTest();

	const result = await harness.emit("tool_call", {
		toolName: "read",
		input: { path: ".git/config" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 0);
});

test("write to unprotected path bypasses protected path check", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "allow", tier: "allow", reason: "ok" }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "write",
		input: { path: "src/index.ts", content: "const x = 1;" },
	}, harness.ctx);

	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("protected paths config can extend defaults", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [
			{ autoMode: { protectedPaths: ["$defaults", ".my-config-dir"] } },
		],
	});

	assert.equal(config.protectedPaths.includes(".my-config-dir"), true);
	assert.equal(DEFAULT_PROTECTED_PATHS.every((p) => config.protectedPaths.includes(p)), true);
});

test("protected paths config can replace defaults", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [
			{ autoMode: { protectedPaths: ["only-this-dir"] } },
		],
	});

	assert.deepEqual(config.protectedPaths, ["only-this-dir"]);
});

test("write through symlink to protected path triggers classifier", async () => {
	const tmpDir = mkdtempSync(join(os.tmpdir(), "pi-automode-test-"));
	try {
		mkdirSync(join(tmpDir, ".git"));
		symlinkSync(".git", join(tmpDir, "not-git"));

		const harness = await setupHookTest({
			ctx: createFakeCtx([], { cwd: tmpDir }),
			classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "no writes to git via symlink" }),
		});

		const result = await harness.emit("tool_call", {
			toolName: "write",
			input: { path: join(tmpDir, "not-git/config"), content: "[core]" },
		}, harness.ctx) as { block?: boolean; reason?: string };

		assert.equal(result.block, true);
		assert.equal(harness.classifierCalls, 1);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("cross-project write to protected path triggers classifier", async () => {
	const projectA = mkdtempSync(join(os.tmpdir(), "pi-automode-a-"));
	const projectB = mkdtempSync(join(os.tmpdir(), "pi-automode-b-"));
	try {
		mkdirSync(join(projectB, ".git"));

		const harness = await setupHookTest({
			ctx: createFakeCtx([], { cwd: projectA }),
			classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "cross-project .git write" }),
		});

		// Write to ../project-b/.git/config from project-a
		const result = await harness.emit("tool_call", {
			toolName: "write",
			input: { path: join(projectB, ".git/config"), content: "[core]" },
		}, harness.ctx) as { block?: boolean; reason?: string };

		assert.equal(result.block, true);
		assert.equal(harness.classifierCalls, 1);
	} finally {
		rmSync(projectA, { recursive: true, force: true });
		rmSync(projectB, { recursive: true, force: true });
	}
});

test("statusLine: enabled with no classifier calls omits the ca/cd segment", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 6, blockedActions: 1 });
	assert.equal(statusLine(config, state), "AM● a:5 d:1");
});

test("statusLine: enabled with classifier calls appends ca/cd segment", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 6, blockedActions: 1, classifierAllowed: 2, classifierDenied: 1 });
	assert.equal(statusLine(config, state), "AM● a:5 d:1 ca:2 cd:1");
});

test("statusLine: disabled shows empty circle with frozen counts", () => {
	const config = baseConfig({ enabled: false });
	const state = baseState({ checkedActions: 18, blockedActions: 3, classifierAllowed: 7, classifierDenied: 5 });
	assert.equal(statusLine(config, state), "AM○ a:15 d:3 ca:7 cd:5");
});

test("statusLine: enabledOverride:false overrides an enabled config", () => {
	const config = baseConfig({ enabled: true });
	const state = baseState({ enabledOverride: false, checkedActions: 4, blockedActions: 1 });
	assert.equal(statusLine(config, state), "AM○ a:3 d:1");
});

test("statusLine: allowed is derived from checked minus blocked", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 10, blockedActions: 3, classifierAllowed: 1, classifierDenied: 1 });
	assert.equal(statusLine(config, state), "AM● a:7 d:3 ca:1 cd:1");
});

test("statusLine: zero counts render a:0 d:0 with no ca/cd segment", () => {
	const config = baseConfig();
	assert.equal(statusLine(config, baseState()), "AM● a:0 d:0");
});

test("statusLine: classifier segment shows when only allows have happened", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 4, blockedActions: 0, classifierAllowed: 3, classifierDenied: 0 });
	assert.equal(statusLine(config, state), "AM● a:4 d:0 ca:3 cd:0");
});

test("statusLine: classifier segment shows when only denials have happened", () => {
	const config = baseConfig();
	const state = baseState({ checkedActions: 2, blockedActions: 2, classifierAllowed: 0, classifierDenied: 2 });
	assert.equal(statusLine(config, state), "AM● a:0 d:2 ca:0 cd:2");
});

// --- observability logging -------------------------------------------------

test("log config defaults to disabled with classifier I/O off", () => {
	const config = buildEffectiveConfigFromSources({});
	assert.deepEqual(config.log, { enabled: false, classifierIo: false });
});

test("log config merges field-by-field across configurable scopes", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { log: { enabled: true } } }],
		projectLocalSettings: [{ autoMode: { log: { classifierIo: true } } }],
	});
	assert.equal(config.log.enabled, true);
	assert.equal(config.log.classifierIo, true);
});

test("shared project settings cannot set log config", () => {
	const config = buildEffectiveConfigFromSources({
		projectSharedSettings: [{ autoMode: { log: { enabled: true, classifierIo: true } } }],
	});
	assert.equal(config.log.enabled, false);
	assert.equal(config.log.classifierIo, false);
});

test("log config validation reports wrong types", () => {
	const diagnostics = validateSettingsFile({
		autoMode: { log: { enabled: "yes", classifierIo: 1 } },
	} as any, "test-config");
	assert.equal(diagnostics.some((d) => d.includes("autoMode.log.enabled must be a boolean")), true);
	assert.equal(diagnostics.some((d) => d.includes("autoMode.log.classifierIo must be a boolean")), true);

	const diagnostics2 = validateSettingsFile({
		autoMode: { log: "nope" },
	} as any, "test-config");
	assert.equal(diagnostics2.some((d) => d.includes("autoMode.log must be an object")), true);
});

test("resolveLogPath inserts -pi-automode before the extension", () => {
	assert.equal(
		resolveLogPath("/home/.pi/agent/sessions/slug/abc123.jsonl", "/dir", "id"),
		"/home/.pi/agent/sessions/slug/abc123-pi-automode.jsonl",
	);
});

test("resolveLogPath falls back to sessionDir/sessionId when no session file", () => {
	assert.equal(
		resolveLogPath(undefined, "/dir/slug", "abc123"),
		"/dir/slug/abc123-pi-automode.jsonl",
	);
});

test("newDecisionId returns distinct ids", () => {
	assert.notEqual(newDecisionId(), newDecisionId());
});

test("createLogger is a no-op when disabled", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: false, classifierIo: true, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "decision", ts: "t", decisionId: "d", cwd: "/tmp", tool: "bash", summary: "s", kind: "classifier", outcome: "block", reason: "r" });
		assert.equal(existsSync(join(dir, "abc-pi-automode.jsonl")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createLogger writes decision entries when enabled", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: true, classifierIo: false, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "decision", ts: "t", decisionId: "d1", cwd: "/tmp", tool: "bash", summary: "s", kind: "classifier", outcome: "block", reason: "r" });
		const logPath = join(dir, "abc-pi-automode.jsonl");
		assert.equal(existsSync(logPath), true);
		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(lines[0]), { type: "decision", ts: "t", decisionId: "d1", cwd: "/tmp", tool: "bash", summary: "s", kind: "classifier", outcome: "block", reason: "r" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createLogger skips classifier entries when classifierIo is false", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: true, classifierIo: false, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "classifier", ts: "t", decisionId: "d1", model: "m", prompt: { system: "s", user: "u" }, attempts: [], durationMs: 5, parsed: { decision: "allow", tier: "none", reason: "r" } });
		assert.equal(existsSync(join(dir, "abc-pi-automode.jsonl")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("createLogger writes classifier entries when classifierIo is true", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "abc.jsonl");
		const logger = createLogger({ enabled: true, classifierIo: true, sessionFile, sessionDir: dir, sessionId: "abc" });
		logger.append({ type: "classifier", ts: "t", decisionId: "d1", model: "m", prompt: { system: "s", user: "u" }, attempts: [], durationMs: 5, parsed: { decision: "allow", tier: "none", reason: "r" } });
		const lines = readFileSync(join(dir, "abc-pi-automode.jsonl"), "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).type, "classifier");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("classifyWithRetry reports each attempt's usage via onAttempt", async () => {
	const first = assistantWith(GARBAGE);
	first.model = "glm-5.2";
	first.timestamp = Date.parse("2026-07-10T12:00:00.000Z");
	first.usage = { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const { fn } = fakeComplete([first, assistantWith(VALID_ALLOW)]);
	const attempts: ClassifierIoAttempt[] = [];
	const decision = await classifyWithRetry(
		fn,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
		{ onAttempt: (a) => attempts.push(a) },
	);
	assert.equal(decision.decision, "allow");
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0]?.parsed, undefined);
	assert.deepEqual(attempts[0]?.response, {
		stopReason: "stop",
		text: GARBAGE,
		model: "glm-5.2",
		timestamp: Date.parse("2026-07-10T12:00:00.000Z"),
		usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
	assert.equal(attempts[1]?.parsed?.decision, "allow");
});

test("classifyWithRetry reports a thrown attempt via onAttempt and fails closed", async () => {
	const attempts: ClassifierIoAttempt[] = [];
	const fn = async () => {
		throw new Error("network down");
	};
	const decision = await classifyWithRetry(
		fn as never,
		{ model: { provider: "test", id: "x" } },
		{ systemPrompt: "s", messages: [] },
		undefined,
		{ onAttempt: (a) => attempts.push(a) },
	);
	assert.equal(decision.decision, "block");
	assert.equal(attempts.length, 1);
	assert.match(attempts[0]?.error ?? "", /network down/);
	assert.equal(attempts[0]?.response, undefined);
});

async function setupLogTest(options: {
	config?: EffectiveConfig;
	classifier?: ClassifyAction;
} = {}) {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	const sessionFile = join(dir, "sess.jsonl");
	const classifier = options.classifier ?? (async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }));
	const fake = createFakePi();
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig({ log: { enabled: true, classifierIo: false } }),
		classifyAction: async () => classifier(),
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, { sessionFile });
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return { dir, sessionFile, fake, ctx, logPath: join(dir, "sess-pi-automode.jsonl") };
}

test("tool_call writes no log file when logging is disabled", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-log-"));
	try {
		const sessionFile = join(dir, "sess.jsonl");
		const fake = createFakePi();
		createPiAutomode({
			loadConfig: () => baseConfig(),
			classifyAction: async () => ({ decision: "block", tier: "soft_deny", reason: "mock" }),
		})(fake.pi);
		const ctx = createFakeCtx(fake.entries, { sessionFile });
		await fake.emit("session_start", { type: "session_start" }, ctx);
		await fake.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, ctx);
		assert.equal(existsSync(join(dir, "sess-pi-automode.jsonl")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tool_call logs blocked classifier decisions to the session log file", async () => {
	const t = await setupLogTest({
		classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "mock block" }),
	});
	try {
		await t.fake.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, t.ctx);
		assert.equal(existsSync(t.logPath), true);
		const lines = readFileSync(t.logPath, "utf8").trim().split("\n");
		assert.equal(lines.length, 1);
		const entry = JSON.parse(lines[0]);
		assert.equal(entry.type, "decision");
		assert.equal(entry.outcome, "block");
		assert.equal(entry.kind, "classifier");
		assert.equal(entry.tool, "bash");
		assert.equal(entry.sessionId, "test-session");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs read-only allows with kind read-only", async () => {
	const t = await setupLogTest();
	try {
		await t.fake.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, t.ctx);
		const entry = JSON.parse(readFileSync(t.logPath, "utf8").trim());
		assert.equal(entry.type, "decision");
		assert.equal(entry.outcome, "allow");
		assert.equal(entry.kind, "read-only");
		assert.equal(entry.tool, "read");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs deterministic hard-deny blocks", async () => {
	const t = await setupLogTest();
	try {
		await t.fake.emit("tool_call", { toolName: "write", input: { path: ".pi/automode.local.json", content: "{}" } }, t.ctx);
		const entry = JSON.parse(readFileSync(t.logPath, "utf8").trim());
		assert.equal(entry.type, "decision");
		assert.equal(entry.outcome, "block");
		assert.equal(entry.kind, "deterministic-hard-deny");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs ccusage-compatible classifier usage without classifier I/O", async () => {
	const t = await setupLogTest({
		classifier: async () => ({
			decision: "allow",
			tier: "allow",
			reason: "ok",
			io: {
				model: "test/glm-5.2",
				prompt: { system: "s", user: "u" },
				attempts: [{
					attempt: 1,
					response: {
						stopReason: "stop",
						text: '{"decision":"allow"}',
						model: "glm-5.2",
						timestamp: Date.parse("2026-07-10T12:00:00.000Z"),
						usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					},
					durationMs: 1,
				}],
				durationMs: 1,
			},
		}),
	});
	try {
		await t.fake.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, t.ctx);
		const lines = readFileSync(t.logPath, "utf8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(lines[0], {
			type: "message",
			timestamp: "2026-07-10T12:00:00.000Z",
			message: {
				role: "assistant",
				model: "glm-5.2",
				usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
		});
		assert.equal(lines[1].type, "decision");
		assert.equal(lines[1].outcome, "allow");
		assert.equal(lines[1].kind, "classifier");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("tool_call logs ccusage-compatible usage, classifier I/O, and decision", async () => {
	const t = await setupLogTest({
		config: baseConfig({ log: { enabled: true, classifierIo: true } }),
		classifier: async () => ({
			decision: "allow",
			tier: "allow",
			reason: "ok",
			io: {
				model: "test/classifier",
				prompt: { system: "sys", user: "usr" },
				attempts: [
					{
						attempt: 1,
						response: {
							stopReason: "length",
							text: "not json",
							model: "classifier",
							timestamp: Date.parse("2026-07-10T12:00:00.000Z"),
							usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						},
						durationMs: 4,
					},
					{
						attempt: 2,
						response: {
							stopReason: "stop",
							text: '{"decision":"allow"}',
							model: "classifier",
							timestamp: Date.parse("2026-07-10T12:00:01.000Z"),
							usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						},
						parsed: { decision: "allow", tier: "allow", reason: "ok" },
						durationMs: 4,
					},
				],
				durationMs: 5,
			},
		}),
	});
	try {
		await t.fake.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, t.ctx);
		const lines = readFileSync(t.logPath, "utf8").trim().split("\n").map(JSON.parse);
		assert.equal(lines.length, 4);
		assert.deepEqual(lines.slice(0, 2).map((line) => line.message), [
			{ role: "assistant", model: "classifier", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
			{ role: "assistant", model: "classifier", usage: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, totalTokens: 50, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
		]);
		const classifierEntry = lines[2];
		const decisionEntry = lines[3];
		assert.equal(classifierEntry.type, "classifier");
		assert.equal(decisionEntry.type, "decision");
		assert.equal(classifierEntry.decisionId, decisionEntry.decisionId);
		assert.equal(decisionEntry.outcome, "allow");
		assert.equal(decisionEntry.kind, "classifier");
		assert.equal(classifierEntry.model, "test/classifier");
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});

test("/automode config names the current log file", async () => {
	const t = await setupLogTest({
		config: baseConfig({ log: { enabled: true, classifierIo: false } }),
	});
	try {
		await t.fake.commands.get("automode")?.handler("config", t.ctx);
		const notify = t.ctx.notifications.at(-1);
		assert.ok(notify);
		const parsed = JSON.parse(notify.message);
		assert.equal(parsed.logFile, t.logPath);
		assert.equal(parsed.config.log.enabled, true);
	} finally {
		rmSync(t.dir, { recursive: true, force: true });
	}
});
