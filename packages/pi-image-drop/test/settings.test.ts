import assert from "node:assert/strict";
import {
	chmod,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
	DEFAULT_SETTINGS,
	HARD_LIMITS,
	loadSettings,
	normalizeSettings,
	saveSettings,
	updateSettings,
} from "../src/settings.js";

test("settings normalize partial values, preserve compatibility fields, and reject unsafe values", () => {
	assert.equal(DEFAULT_SETTINGS.startOnSessionStart, false);
	assert.equal(DEFAULT_SETTINGS.maxRetainedImages, 128);
	assert.equal(DEFAULT_SETTINGS.maxRetainedBytes, 512 * 1024 * 1024);
	assert.equal(HARD_LIMITS.maxRetainedImages, 256);
	assert.equal(HARD_LIMITS.maxRetainedBytes, 1024 * 1024 * 1024);
	assert.deepEqual(normalizeSettings({ maxImages: 4 }), { ...DEFAULT_SETTINGS, maxImages: 4 });
	assert.deepEqual(normalizeSettings({ startOnSessionStart: true }), {
		...DEFAULT_SETTINGS,
		startOnSessionStart: true,
	});
	assert.deepEqual(normalizeSettings({ startOnSessionStart: false }), DEFAULT_SETTINGS);
	assert.equal(normalizeSettings({ startOnSessionStart: "yes" }), undefined);
	assert.deepEqual(normalizeSettings({ unknown: 1 }), DEFAULT_SETTINGS);
	assert.equal(normalizeSettings({ maxImages: 0 }), undefined);
	assert.equal(normalizeSettings({ maxImages: HARD_LIMITS.maxImages + 1 }), undefined);
	assert.equal(normalizeSettings({ maxImageBytes: DEFAULT_SETTINGS.maxBatchBytes + 1 }), undefined);
	assert.equal(
		normalizeSettings({ maxRetainedImages: HARD_LIMITS.maxRetainedImages + 1 }),
		undefined,
	);
	assert.equal(
		normalizeSettings({ maxRetainedBytes: HARD_LIMITS.maxRetainedBytes + 1 }),
		undefined,
	);
	assert.equal(normalizeSettings([]), undefined);
});

test("settings loading distinguishes missing, valid, warned, and invalid files", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	try {
		assert.deepEqual(await loadSettings(settingsPath), {
			kind: "missing",
			settings: { ...DEFAULT_SETTINGS },
		});
		await writeFile(
			settingsPath,
			'{"maxImages":4,"maxRetainedImages":32,"maxRetainedBytes":268435456,"startOnSessionStart":true}\n',
		);
		assert.deepEqual(await loadSettings(settingsPath), {
			kind: "loaded",
			settings: {
				...DEFAULT_SETTINGS,
				maxImages: 4,
				maxRetainedImages: 32,
				maxRetainedBytes: 256 * 1024 * 1024,
				startOnSessionStart: true,
			},
			warning: undefined,
		});
		await writeFile(settingsPath, '{"maxImages":16}\n');
		const warned = await loadSettings(settingsPath);
		assert.equal(warned.kind, "loaded");
		assert.match("warning" in warned ? (warned.warning ?? "") : "", /raises maxImages/i);
		await writeFile(settingsPath, '{"startOnSessionStart":"yes"}\n');
		const invalidBoolean = await loadSettings(settingsPath);
		assert.equal(invalidBoolean.kind, "invalid");
		assert.deepEqual(invalidBoolean.settings, DEFAULT_SETTINGS);
		await writeFile(settingsPath, '{"maxImages":"many"}\n');
		const invalid = await loadSettings(settingsPath);
		assert.equal(invalid.kind, "invalid");
		assert.deepEqual(invalid.settings, DEFAULT_SETTINGS);
		assert.match("warning" in invalid ? invalid.warning : "", /using safe defaults/i);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("settings loads are bounded and cancellable", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-bounds-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	try {
		await writeFile(settingsPath, JSON.stringify({ padding: "x".repeat(64 * 1024) }));
		const oversized = await loadSettings(settingsPath);
		assert.equal(oversized.kind, "invalid");
		assert.match("warning" in oversized ? oversized.warning : "", /exceeds 65536 bytes/i);

		await writeFile(settingsPath, "{}\n");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			loadSettings(settingsPath, controller.signal),
			(error: unknown) => error instanceof Error && error.name === "AbortError",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("settings saves are atomic and preserve unknown fields", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-save-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	try {
		await writeFile(settingsPath, '{"future":{"enabled":true},"maxImages":4}\n');
		await saveSettings(
			{ ...DEFAULT_SETTINGS, maxImages: 6, startOnSessionStart: true },
			settingsPath,
		);
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(saved.future, { enabled: true });
		assert.equal(saved.maxImages, 6);
		assert.equal(saved.startOnSessionStart, true);
		assert.deepEqual(
			(await readdir(directory)).filter((name) => name !== "pi-image-drop.json"),
			[],
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("settings patches preserve recognized fields changed after an earlier read", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-patch-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	try {
		await writeFile(settingsPath, '{"startOnSessionStart":false,"maxImages":8}\n');
		const earlier = await loadSettings(settingsPath);
		assert.equal(earlier.settings.maxImages, 8);
		await writeFile(settingsPath, '{"startOnSessionStart":false,"maxImages":12}\n');
		await updateSettings({ startOnSessionStart: true }, settingsPath);
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(saved.startOnSessionStart, true);
		assert.equal(saved.maxImages, 12);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent settings saves publish in user action order", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-order-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	let releaseFirst!: () => void;
	let firstStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		firstStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	try {
		await writeFile(settingsPath, '{"maxImages":3,"future":"kept"}\n');
		const first = saveSettings({ ...DEFAULT_SETTINGS, maxImages: 4 }, settingsPath, {
			rename: async (source, destination) => {
				firstStarted();
				await release;
				await rename(source, destination);
			},
		});
		await started;
		const second = saveSettings({ ...DEFAULT_SETTINGS, maxImages: 6 }, settingsPath);
		releaseFirst();
		await Promise.all([first, second]);
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(saved.maxImages, 6);
		assert.equal(saved.future, "kept");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("settings loads wait for an earlier queued save", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-read-order-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	let releaseSave!: () => void;
	let markSaveStarted!: () => void;
	const saveStarted = new Promise<void>((resolve) => {
		markSaveStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	try {
		await writeFile(settingsPath, '{"startOnSessionStart":false}\n');
		const saving = saveSettings({ ...DEFAULT_SETTINGS, startOnSessionStart: true }, settingsPath, {
			rename: async (source, destination) => {
				markSaveStarted();
				await release;
				await rename(source, destination);
			},
		});
		await saveStarted;
		let loadSettled = false;
		const loading = loadSettings(settingsPath).then((result) => {
			loadSettled = true;
			return result;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(loadSettled, false);
		releaseSave();
		await saving;
		const loaded = await loading;
		assert.equal(loaded.settings.startOnSessionStart, true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("settings load cancellation does not wait for a pending write", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-read-abort-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	let releaseSave!: () => void;
	let markSaveStarted!: () => void;
	const saveStarted = new Promise<void>((resolve) => {
		markSaveStarted = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	try {
		await writeFile(settingsPath, "{}\n");
		const saving = saveSettings({ ...DEFAULT_SETTINGS, maxImages: 4 }, settingsPath, {
			rename: async (source, destination) => {
				markSaveStarted();
				await release;
				await rename(source, destination);
			},
		});
		await saveStarted;
		const controller = new AbortController();
		const loading = loadSettings(settingsPath, controller.signal);
		controller.abort();
		const outcome = await Promise.race([
			loading.then(
				() => "loaded",
				(error: unknown) => (error instanceof Error ? error.name : String(error)),
			),
			new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 25)),
		]);
		assert.equal(outcome, "AbortError");
		releaseSave();
		await saving;
	} finally {
		releaseSave?.();
		await rm(directory, { recursive: true, force: true });
	}
});

test("failed atomic publication preserves the previous settings and cleans temporary files", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-fail-"));
	const settingsPath = path.join(directory, "pi-image-drop.json");
	const original = '{"maxImages":4,"future":"kept"}\n';
	try {
		await writeFile(settingsPath, original);
		await assert.rejects(
			saveSettings({ ...DEFAULT_SETTINGS, maxImages: 6 }, settingsPath, {
				rename: async () => {
					throw new Error("publish failed");
				},
			}),
			/publish failed/,
		);
		assert.equal(await readFile(settingsPath, "utf8"), original);
		assert.deepEqual(await readdir(directory), ["pi-image-drop.json"]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("unreadable and symlink settings do not escape whole-file fallback", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-image-drop-settings-"));
	const target = path.join(directory, "target.json");
	const settingsPath = path.join(directory, "pi-image-drop.json");
	try {
		await writeFile(target, '{"maxImages":3}\n');
		await symlink(target, settingsPath);
		const linked = await loadSettings(settingsPath);
		assert.equal(linked.kind, "invalid");
		assert.match("warning" in linked ? linked.warning : "", /symbolic link/i);
		await rm(settingsPath);
		await writeFile(settingsPath, '{"maxImages":3}\n');
		if (process.platform === "win32" || process.getuid?.() === 0) {
			await t.annotate("permission-denied read is not meaningful on this platform/user");
			return;
		}
		await chmod(settingsPath, 0);
		const unreadable = await loadSettings(settingsPath);
		assert.equal(unreadable.kind, "invalid");
	} finally {
		await chmod(settingsPath, 0o600).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}
});
