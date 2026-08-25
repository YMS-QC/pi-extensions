import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_ALLOW,
	DEFAULT_ALLOW_INSIDE_WORKING_DIRECTORY,
	DEFAULT_CLASSIFY_READ_ONLY_TOOLS,
	DEFAULT_HARD_DENY,
	DEFAULT_MAX_USER_TRANSCRIPT_TOKENS,
	DEFAULT_SOFT_DENY,
	PI_GLOBAL_SETTINGS,
	buildEffectiveConfigFromSources,
	createPiAutomode,
	loadEffectiveConfigWithDiagnostics,
	modelVisibleConfigDiagnostics,
	validateSettingsFile,
	writeGlobalClassifierModel,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	createFakeCtx,
	createFakePi,
} from "./test-helpers.ts";

test("model-visible config diagnostics omit JSON parser excerpts", () => {
	const diagnostics = modelVisibleConfigDiagnostics([
		"PI_AUTOMODE_SETTINGS_JSON: invalid JSON (Unexpected token near SECRET_VALUE)",
		"/tmp/automode.json: unknown autoMode key typo",
	]);
	assert.deepEqual(diagnostics, [
		"PI_AUTOMODE_SETTINGS_JSON: invalid JSON (parser details omitted from model-visible output)",
		"/tmp/automode.json: unknown autoMode key typo",
	]);
	assert.doesNotMatch(diagnostics.join("\n"), /SECRET_VALUE/);
});

test("automode exposes one read-only inspection tool", () => {
	const fake = createFakePi();
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	assert.deepEqual([...fake.tools.keys()], ["automode_inspect"]);
	assert.deepEqual([...fake.commands.keys()], ["automode", "auto-mode"]);
});

test("global config path uses Pi agent config directory", () => {
	assert.match(PI_GLOBAL_SETTINGS[0] ?? "", /\.pi\/agent\/automode\.json$/);
});

test("disk config ignores all project files until the project is trusted", () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-trust-"));
	const previousInlineSettings = process.env.PI_AUTOMODE_SETTINGS_JSON;
	delete process.env.PI_AUTOMODE_SETTINGS_JSON;
	try {
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		const localPath = join(piDir, "automode.local.json");
		const sharedPath = join(piDir, "automode.json");
		writeFileSync(localPath, JSON.stringify({
			autoMode: {
				enabled: false,
				classifierModel: "project/trusted-marker",
				allow: ["project trusted allow"],
				soft_deny: ["project trusted soft deny"],
				hard_deny: ["project trusted hard deny"],
			},
		}));
		writeFileSync(sharedPath, JSON.stringify({
			permissions: {
				deny: ["bash(project-trusted-command *)"],
				ask: ["write(project-trusted-path *)"],
			},
		}));

		const untrusted = loadEffectiveConfigWithDiagnostics(dir, false);
		assert.notEqual(untrusted.config.classifierModel, "project/trusted-marker");
		assert.equal(untrusted.config.allow.includes("project trusted allow"), false);
		assert.equal(untrusted.config.softDeny.includes("project trusted soft deny"), false);
		assert.equal(untrusted.config.hardDeny.includes("project trusted hard deny"), false);
		assert.equal(
			untrusted.config.permissionDeny.some((pattern) => pattern.raw === "bash(project-trusted-command *)"),
			false,
		);
		assert.equal(
			untrusted.config.permissionAsk.some((pattern) => pattern.raw === "write(project-trusted-path *)"),
			false,
		);
		assert.equal(
			untrusted.diagnostics.includes(`${localPath}: ignored because project is not trusted`),
			true,
		);
		assert.equal(
			untrusted.diagnostics.includes(`${sharedPath}: ignored because project is not trusted`),
			true,
		);

		const trusted = loadEffectiveConfigWithDiagnostics(dir, true);
		assert.equal(trusted.config.enabled, false);
		assert.equal(trusted.config.classifierModel, "project/trusted-marker");
		assert.equal(trusted.config.allow.includes("project trusted allow"), true);
		assert.equal(trusted.config.softDeny.includes("project trusted soft deny"), true);
		assert.equal(trusted.config.hardDeny.includes("project trusted hard deny"), true);
		assert.equal(
			trusted.config.permissionDeny.some((pattern) => pattern.raw === "bash(project-trusted-command *)"),
			true,
		);
		assert.equal(
			trusted.config.permissionAsk.some((pattern) => pattern.raw === "write(project-trusted-path *)"),
			true,
		);
		assert.equal(
			trusted.diagnostics.some((line) => line.includes("ignored because project is not trusted")),
			false,
		);
	} finally {
		if (previousInlineSettings === undefined) {
			delete process.env.PI_AUTOMODE_SETTINGS_JSON;
		} else {
			process.env.PI_AUTOMODE_SETTINGS_JSON = previousInlineSettings;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("extension gates initial and reloaded project config on current trust", async () => {
	const fake = createFakePi();
	const loads: Array<{ cwd: string; projectTrusted: boolean }> = [];
	createPiAutomode({
		loadConfig: (cwd, projectTrusted) => {
			loads.push({ cwd, projectTrusted });
			return baseConfig({ enabled: !projectTrusted });
		},
	})(fake.pi);

	const untrustedCtx = createFakeCtx(fake.entries, {
		isProjectTrusted: () => false,
	});
	const initialOutput = await fake.tools.get("automode_inspect")?.execute(
		"call-initial-config",
		{ action: "config" },
		undefined,
		undefined,
		untrustedCtx,
	);
	assert.equal(initialOutput.details.config.enabled, true);
	assert.deepEqual(loads, [{ cwd: process.cwd(), projectTrusted: false }]);

	await fake.emit("session_start", { type: "session_start" }, untrustedCtx);
	await fake.commands.get("automode")?.handler("reload", untrustedCtx);
	assert.deepEqual(loads.map((load) => load.projectTrusted), [false, false, false]);

	const trustedCtx = createFakeCtx(fake.entries, {
		isProjectTrusted: () => true,
	});
	await fake.emit("session_start", { type: "session_start" }, trustedCtx);
	await fake.commands.get("automode")?.handler("reload", trustedCtx);
	assert.deepEqual(loads.map((load) => load.projectTrusted), [false, false, false, true, true]);

	const trustedOutput = await fake.tools.get("automode_inspect")?.execute(
		"call-trusted-config",
		{ action: "config" },
		undefined,
		undefined,
		trustedCtx,
	);
	assert.equal(trustedOutput.details.config.enabled, false);
});

test("project shared Pi settings can add deny and ask permissions but cannot weaken autoMode", () => {
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
					ask: ["bash(git push *)"],
					allow: ["bash(*)"],
				},
			},
		],
	});

	assert.equal(config.classifierModel, undefined);
	assert.equal(config.allow.includes("checked-in repo tries to allow everything"), false);
	assert.equal(config.hardDeny.includes("checked-in repo tries to replace hard denies"), false);
	assert.equal(config.permissionDeny.length, 1);
	assert.equal(config.permissionDeny[0]?.raw, "bash(git push --force*)");
	assert.deepEqual(config.permissionAsk.map((pattern) => pattern.raw), ["bash(git push *)"]);
	assert.deepEqual(config.permissionAllow, []);
});

test("permissions.allow is read only from user-owned permission scopes", () => {
	assert.deepEqual(buildEffectiveConfigFromSources({}).permissionAllow, []);

	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ permissions: { allow: ["noop"] } }],
		projectSharedSettings: [{ permissions: { allow: ["bash(*)"], deny: ["bash(rm -rf *)"] } }],
		projectLocalSettings: [{ permissions: { allow: ["bash(git status*)"] } }],
		inlineSettings: [{ permissions: { allow: ["example-extension-tool"] } }],
	});

	assert.deepEqual(config.permissionAllow.map((pattern) => pattern.raw), [
		"noop",
		"bash(git status*)",
		"example-extension-tool",
	]);
	assert.deepEqual(config.permissionDeny.map((pattern) => pattern.raw), ["bash(rm -rf *)"]);
});

test("shared project permissions.allow is ignored with a diagnostic", () => {
	const project = mkdtempSync(join(os.tmpdir(), "pi-automode-shared-allow-"));
	try {
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(project, ".pi/automode.json"),
			JSON.stringify({ permissions: { allow: ["bash(git status*)"], deny: ["bash(rm -rf *)"] } }),
		);

		const { config, diagnostics } = loadEffectiveConfigWithDiagnostics(project, true);

		assert.equal(
			config.permissionAllow.some((pattern) => pattern.raw === "bash(git status*)"),
			false,
		);
		assert.equal(config.permissionDeny.some((pattern) => pattern.raw === "bash(rm -rf *)"), true);
		assert.equal(
			diagnostics.some((line) =>
				line.includes(join(project, ".pi/automode.json")) &&
				line.includes("permissions.allow") &&
				line.includes("ignored")
			),
			true,
		);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
});

test("validateSettingsFile accepts permissions.allow and validates its entries", () => {
	assert.deepEqual(
		validateSettingsFile({ permissions: { allow: ["noop", "bash(git status*)"] } }, "inline"),
		[],
	);

	const notAnArray = validateSettingsFile(
		{ permissions: { allow: "noop" } },
		"inline",
	);
	assert.deepEqual(notAnArray, ["inline: permissions.allow must be an array of tool patterns"]);

	const badEntry = validateSettingsFile(
		{ permissions: { allow: ["noop", 42] } },
		"inline",
	);
	assert.deepEqual(badEntry, ["inline: permissions.allow[1] must be a tool pattern string"]);

	assert.equal(
		validateSettingsFile({ permissions: { allow: ["noop"] } }, "inline")
			.some((line) => line.includes("unknown permissions key")),
		false,
	);
});

test("project-local classifier model overrides global classifier model", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierModel: "global/model" } }],
		projectLocalSettings: [{ autoMode: { classifierModel: "project/model" } }],
	});

	assert.equal(config.classifierModel, "project/model");
});

test("classifier reasoning level defaults to server choice and follows configurable precedence", () => {
	assert.equal(buildEffectiveConfigFromSources({}).classifierReasoningLevel, undefined);

	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierReasoningLevel: "low" } }],
		projectLocalSettings: [{ autoMode: { classifierReasoningLevel: "medium" } }],
		inlineSettings: [{ autoMode: { classifierReasoningLevel: "max" } }],
	});
	assert.equal(config.classifierReasoningLevel, "max");
});

test("classifier reasoning level accepts the supported values and ignores shared project settings", () => {
	for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
		const diagnostics = validateSettingsFile({
			autoMode: { classifierReasoningLevel: level },
		}, "test-config");
		assert.deepEqual(diagnostics, []);
		assert.equal(
			buildEffectiveConfigFromSources({
				projectLocalSettings: [{ autoMode: { classifierReasoningLevel: level } }],
			}).classifierReasoningLevel,
			level,
		);
	}

	const shared = buildEffectiveConfigFromSources({
		projectSharedSettings: [{ autoMode: { classifierReasoningLevel: "high" } }],
	});
	assert.equal(shared.classifierReasoningLevel, undefined);
});

test("invalid classifier reasoning levels produce diagnostics and do not override valid config", () => {
	const diagnostics = validateSettingsFile({
		autoMode: { classifierReasoningLevel: "extreme" },
	} as any, "test-config");
	assert.equal(
		diagnostics.some((line) => line.includes("autoMode.classifierReasoningLevel must be one of")),
		true,
	);

	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierReasoningLevel: "low" } }],
		projectLocalSettings: [{ autoMode: { classifierReasoningLevel: "extreme" } as any }],
	});
	assert.equal(config.classifierReasoningLevel, "low");
});

test("invalid boolean config values produce diagnostics and do not override defaults", () => {
	// enabled: 0 should not disable enforcement
	const diagEnabled0 = validateSettingsFile({
		autoMode: { enabled: 0 },
	} as any, "test-config");
	assert.equal(
		diagEnabled0.some((line) => line.includes("autoMode.enabled must be a boolean")),
		true,
	);
	const configEnabled0 = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { enabled: 0 } as any }],
	});
	assert.equal(configEnabled0.enabled, true);

	// enabled: "false" should not enable enforcement from a disabled base
	const diagEnabledStr = validateSettingsFile({
		autoMode: { enabled: "false" },
	} as any, "test-config");
	assert.equal(
		diagEnabledStr.some((line) => line.includes("autoMode.enabled must be a boolean")),
		true,
	);
	const configEnabledStr = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { enabled: false } }],
		projectLocalSettings: [{ autoMode: { enabled: "false" } as any }],
	});
	assert.equal(configEnabledStr.enabled, false);

	// classifyReadOnlyTools: 1 should not enable classification
	const configCRO = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { classifyReadOnlyTools: 1 } as any }],
	});
	assert.equal(configCRO.classifyReadOnlyTools, DEFAULT_CLASSIFY_READ_ONLY_TOOLS);

	// allowInsideWorkingDirectory: "true" should not enable the tier
	const configAIWD = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { allowInsideWorkingDirectory: "true" } as any }],
	});
	assert.equal(configAIWD.allowInsideWorkingDirectory, DEFAULT_ALLOW_INSIDE_WORKING_DIRECTORY);
});

test("invalid numeric config values produce diagnostics and do not override defaults", () => {
	// classifierTimeoutMs: -1 should be rejected
	const configTimeout = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierTimeoutMs: 5000 } }],
		projectLocalSettings: [{ autoMode: { classifierTimeoutMs: -1 } as any }],
	});
	assert.equal(configTimeout.classifierTimeoutMs, 5000);

	// fastClassifierMaxTokens: 0 should be rejected
	const configFast = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { fastClassifierMaxTokens: 256 } }],
		projectLocalSettings: [{ autoMode: { fastClassifierMaxTokens: 0 } as any }],
	});
	assert.equal(configFast.fastClassifierMaxTokens, 256);

	// maxUserTranscriptTokens: 1 should be rejected
	const configUser = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { maxUserTranscriptTokens: 1 } as any }],
	});
	assert.equal(configUser.maxUserTranscriptTokens, DEFAULT_MAX_USER_TRANSCRIPT_TOKENS);
});

test("invalid log config values produce diagnostics and do not override defaults", () => {
	// log.enabled: 0 should not enable logging
	const configLog = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { log: { enabled: 0 } } as any }],
	});
	assert.equal(configLog.log.enabled, false);

	// log.enabled: 1 should not enable logging (non-boolean rejected)
	const configLogOne = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { log: { enabled: 1 } } as any }],
	});
	assert.equal(configLogOne.log.enabled, false);

	// log.classifierIo: 1 should not enable classifier I/O
	const configIo = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { log: { classifierIo: 1 } } as any }],
	});
	assert.equal(configIo.log.classifierIo, false);
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

test("malformed hard_deny list preserves all default hard-deny rules", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { hard_deny: [42] } as any }],
	});
	assert.deepEqual(config.hardDeny, DEFAULT_HARD_DENY);
});

test("hard_deny with valid entries replaces defaults when $defaults is omitted", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { hard_deny: ["valid-rule"] } }],
	});
	assert.deepEqual(config.hardDeny, ["valid-rule"]);
});

test("hard_deny with $defaults adds to the built-in defaults", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { hard_deny: ["$defaults", "extra-rule"] } }],
	});
	assert.equal(DEFAULT_HARD_DENY.every((rule) => config.hardDeny.includes(rule)), true);
	assert.equal(config.hardDeny.includes("extra-rule"), true);
});

test("hard_deny with malformed and valid entries keeps defaults and adds the valid rule", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { hard_deny: [42, "valid-rule"] } as any }],
	});
	assert.equal(DEFAULT_HARD_DENY.every((rule) => config.hardDeny.includes(rule)), true);
	assert.equal(config.hardDeny.includes("valid-rule"), true);
});

test("empty hard_deny list replaces defaults (documented replacement behavior)", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { hard_deny: [] } }],
	});
	assert.deepEqual(config.hardDeny, []);
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

test("transcript token budgets have conservative defaults and validate overrides", () => {
	const config = buildEffectiveConfigFromSources({
		projectLocalSettings: [{
			autoMode: {
				maxUserTranscriptTokens: 1200,
				maxToolTranscriptTokens: 900,
			},
		}],
	});
	assert.equal(config.maxUserTranscriptTokens, 1200);
	assert.equal(config.maxToolTranscriptTokens, 900);

	const diagnostics = validateSettingsFile({
		autoMode: {
			maxUserTranscriptTokens: "1000000",
			maxToolTranscriptTokens: 1.5,
		} as any,
	}, "test-config");
	assert.equal(diagnostics.some((line) => line.includes("maxUserTranscriptTokens must be an integer of at least 32")), true);
	assert.equal(diagnostics.some((line) => line.includes("maxToolTranscriptTokens must be an integer of at least 32")), true);

	const invalidConfig = buildEffectiveConfigFromSources({
		projectLocalSettings: [{
			autoMode: {
				maxUserTranscriptTokens: "1000000",
				maxToolTranscriptTokens: 1,
			} as any,
		}],
	});
	assert.equal(invalidConfig.maxUserTranscriptTokens, 4000);
	assert.equal(invalidConfig.maxToolTranscriptTokens, 4000);
});

test("classifyReadOnlyTools defaults to false", () => {
	assert.equal(buildEffectiveConfigFromSources({}).classifyReadOnlyTools, false);
});

test("fastClassifierMaxTokens defaults to 512 and is configurable", () => {
	assert.equal(buildEffectiveConfigFromSources({}).fastClassifierMaxTokens, 512);
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { fastClassifierMaxTokens: 2048 } }],
	});
	assert.equal(config.fastClassifierMaxTokens, 2048);
});

test("classifierTimeoutMs defaults to 20000 and is configurable", () => {
	assert.equal(buildEffectiveConfigFromSources({}).classifierTimeoutMs, 20_000);
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierTimeoutMs: 5000 } }],
	});
	assert.equal(config.classifierTimeoutMs, 5000);
});

test("validateSettingsFile rejects non-boolean classifyReadOnlyTools", () => {
	const diagnostics = validateSettingsFile(
		{ autoMode: { classifyReadOnlyTools: "yes" } },
		"inline",
	);
	assert.ok(diagnostics.some((d) => /classifyReadOnlyTools must be a boolean/.test(d)));
});

test("validateSettingsFile rejects fastClassifierMaxTokens below 16", () => {
	const diagnostics = validateSettingsFile(
		{ autoMode: { fastClassifierMaxTokens: 8 } },
		"inline",
	);
	assert.ok(
		diagnostics.some((d) => /fastClassifierMaxTokens must be an integer of at least 16/.test(d)),
	);
});

test("validateSettingsFile rejects classifierTimeoutMs below 1000", () => {
	const diagnostics = validateSettingsFile(
		{ autoMode: { classifierTimeoutMs: 500 } },
		"inline",
	);
	assert.ok(
		diagnostics.some((d) => /classifierTimeoutMs must be an integer of at least 1000/.test(d)),
	);
});

test("validateSettingsFile rejects unknown autoMode keys including classifierTimeoutMs misspellings", () => {
	const diagnostics = validateSettingsFile(
		{ autoMode: { classifierTimeout: 5000 } },
		"inline",
	);
	assert.ok(
		diagnostics.some((d) => /unknown autoMode key classifierTimeout/.test(d)),
	);
});

test("validateSettingsFile accepts valid classifyReadOnlyTools and fastClassifierMaxTokens", () => {
	const diagnostics = validateSettingsFile(
		{ autoMode: { classifyReadOnlyTools: true, fastClassifierMaxTokens: 1024 } },
		"inline",
	);
	assert.equal(diagnostics.length, 0);
});

test("validateSettingsFile accepts a valid classifierTimeoutMs", () => {
	const diagnostics = validateSettingsFile(
		{ autoMode: { classifierTimeoutMs: 10_000 } },
		"inline",
	);
	assert.equal(diagnostics.length, 0);
});
