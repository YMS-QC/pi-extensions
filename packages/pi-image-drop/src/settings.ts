import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_FILE = "pi-image-drop.json";
const MIB = 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface ImageDropLimits {
	maxImages: number;
	maxImageBytes: number;
	maxBatchBytes: number;
	maxImagePixels: number;
	maxRetainedImages: number;
	maxRetainedBytes: number;
}

export interface ImageDropSettings extends ImageDropLimits {
	startOnSessionStart: boolean;
}

export const DEFAULT_SETTINGS: Readonly<ImageDropSettings> = Object.freeze({
	maxImages: 8,
	maxImageBytes: 10 * MIB,
	maxBatchBytes: 40 * MIB,
	maxImagePixels: 50_000_000,
	maxRetainedImages: 128,
	maxRetainedBytes: 512 * MIB,
	startOnSessionStart: false,
});

export const HARD_LIMITS: Readonly<ImageDropLimits> = Object.freeze({
	maxImages: 32,
	maxImageBytes: 50 * MIB,
	maxBatchBytes: 200 * MIB,
	maxImagePixels: 100_000_000,
	maxRetainedImages: 256,
	maxRetainedBytes: 1024 * MIB,
});

const LIMIT_KEYS = new Set<keyof ImageDropLimits>([
	"maxImages",
	"maxImageBytes",
	"maxBatchBytes",
	"maxImagePixels",
	"maxRetainedImages",
	"maxRetainedBytes",
]);
const SETTING_KEYS = new Set<keyof ImageDropSettings>([...LIMIT_KEYS, "startOnSessionStart"]);
const saveQueues = new Map<string, Promise<void>>();

export type SettingsLoadResult =
	| { kind: "missing"; settings: ImageDropSettings }
	| { kind: "loaded"; settings: ImageDropSettings; warning?: string }
	| { kind: "invalid"; settings: ImageDropSettings; warning: string };

export function normalizeSettings(value: unknown): ImageDropSettings | undefined {
	if (!isRecord(value)) return undefined;
	const settings: ImageDropSettings = { ...DEFAULT_SETTINGS };
	for (const key of LIMIT_KEYS) {
		if (!Object.hasOwn(value, key)) continue;
		const candidate = Reflect.get(value, key);
		if (
			typeof candidate !== "number" ||
			!Number.isSafeInteger(candidate) ||
			candidate <= 0 ||
			candidate > HARD_LIMITS[key]
		) {
			return undefined;
		}
		settings[key] = candidate;
	}
	if (Object.hasOwn(value, "startOnSessionStart")) {
		if (typeof value.startOnSessionStart !== "boolean") return undefined;
		settings.startOnSessionStart = value.startOnSessionStart;
	}
	if (settings.maxImageBytes > settings.maxBatchBytes) return undefined;
	return settings;
}

export function settingsFilePath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

export async function loadSettings(
	path = settingsFilePath(),
	signal?: AbortSignal,
): Promise<SettingsLoadResult> {
	await waitForPendingSave(path, signal);
	if (signal?.aborted) throw signal.reason;
	let text: string;
	try {
		text = await readSettingsDocument(path, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		if (isNodeError(error) && error.code === "ENOENT") {
			return { kind: "missing", settings: { ...DEFAULT_SETTINGS } };
		}
		return invalid(path, formatError(error));
	}

	try {
		const settings = normalizeSettings(JSON.parse(text) as unknown);
		if (!settings) return invalid(path, "invalid settings shape or value");
		const raised = [...LIMIT_KEYS].filter((key) => settings[key] > DEFAULT_SETTINGS[key]);
		return {
			kind: "loaded",
			settings,
			warning:
				raised.length > 0
					? `${SETTINGS_FILE} raises ${raised.join(", ")} above the safe defaults; memory use or provider request size may increase.`
					: undefined,
		};
	} catch (error) {
		return invalid(path, formatError(error));
	}
}

export interface SettingsSaveOperations {
	writeFile?: typeof writeFile;
	rename?: typeof rename;
}

export function saveSettings(
	settings: ImageDropSettings,
	path = settingsFilePath(),
	operations: SettingsSaveOperations = {},
): Promise<void> {
	if (!normalizeSettings(settings)) {
		return Promise.reject(new Error("Refusing to save invalid Image Drop settings."));
	}
	return updateSettings(settings, path, operations);
}

export async function updateSettings(
	patch: Partial<ImageDropSettings>,
	path = settingsFilePath(),
	operations: SettingsSaveOperations = {},
): Promise<void> {
	if (Object.keys(patch).some((key) => !SETTING_KEYS.has(key as keyof ImageDropSettings))) {
		throw new Error("Refusing to save unknown Image Drop settings.");
	}
	const previous = saveQueues.get(path) ?? Promise.resolve();
	const next = previous
		.catch(() => undefined)
		.then(() => saveSettingsAtomic(patch, path, operations));
	saveQueues.set(path, next);
	try {
		await next;
	} finally {
		if (saveQueues.get(path) === next) saveQueues.delete(path);
	}
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function waitForPendingSave(path: string, signal?: AbortSignal): Promise<void> {
	const pending = (saveQueues.get(path) ?? Promise.resolve()).catch(() => undefined);
	return abortable(pending, signal);
}

async function openSettingsDescriptor(
	path: string,
	signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof open>>> {
	const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
	const opening = open(path, flags);
	try {
		return await abortable(opening, signal);
	} catch (error) {
		if (signal?.aborted) {
			void opening.then((handle) => handle.close()).catch(() => undefined);
		}
		throw error;
	}
}

async function readSettingsDocument(path: string, signal?: AbortSignal): Promise<string> {
	const handle = await openSettingsDescriptor(path, signal);
	try {
		const [descriptorStats, pathStats] = await Promise.all([
			abortable(handle.stat(), signal),
			abortable(lstat(path), signal),
		]);
		if (pathStats.isSymbolicLink()) throw new Error("symbolic links are not accepted");
		if (!descriptorStats.isFile() || !pathStats.isFile()) {
			throw new Error("settings path is not a regular file");
		}
		if (descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino) {
			throw new Error("settings path changed while it was being opened");
		}
		if (descriptorStats.size > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
		let offset = 0;
		while (offset < buffer.byteLength) {
			const { bytesRead } = await abortable(
				handle.read(buffer, offset, buffer.byteLength - offset, offset),
				signal,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_SETTINGS_BYTES) {
			throw new Error(`settings file exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		const closing = handle.close();
		if (signal?.aborted) void closing.catch(() => undefined);
		else await closing;
	}
}

async function saveSettingsAtomic(
	patch: Partial<ImageDropSettings>,
	path: string,
	operations: SettingsSaveOperations,
): Promise<void> {
	let document: Record<string, unknown> = {};
	let current = { ...DEFAULT_SETTINGS };
	try {
		const parsed = JSON.parse(await readSettingsDocument(path)) as unknown;
		const normalized = normalizeSettings(parsed);
		if (!isRecord(parsed) || !normalized) {
			throw new Error("existing settings are malformed or invalid");
		}
		document = parsed;
		current = normalized;
	} catch (error) {
		if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
	}
	if (!normalizeSettings({ ...current, ...patch })) {
		throw new Error("Refusing to save invalid Image Drop settings.");
	}
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = join(dirname(path), `.${SETTINGS_FILE}.${process.pid}.${randomUUID()}.tmp`);
	try {
		const contents = `${JSON.stringify({ ...document, ...patch }, null, "\t")}\n`;
		if (Buffer.byteLength(contents, "utf8") > MAX_SETTINGS_BYTES) {
			throw new Error(`settings document exceeds ${MAX_SETTINGS_BYTES} bytes`);
		}
		await (operations.writeFile ?? writeFile)(temporaryPath, contents, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		await (operations.rename ?? rename)(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function invalid(path: string, reason: string): SettingsLoadResult {
	return {
		kind: "invalid",
		settings: { ...DEFAULT_SETTINGS },
		warning: `${SETTINGS_FILE} ignored (${path}: ${reason}); using safe defaults.`,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
