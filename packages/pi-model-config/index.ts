/**
 * Model Profiles — 模型方案插件（私有）
 *
 * 思路: 一次切换整个"方案"(profile), 方案= 主模型 + aux(后台小模型) + 各扩展模型的集合。
 * 需要微调时: 改方案定义(JSON) 或对单插件单独覆盖(override), 新插件接入时在方案里加一项 target 即可。
 *
 * 配置: ~/.pi/agent/model-profiles.json
 *   {
 *     "profiles": {
 *       "default": { "main": "zai/glm-5.3", "thinking": "high", "aux": "zai/glm-4.7" },
 *       "cheap":   { "main": "zai/glm-4.7", "thinking": "off",  "aux": "zai/glm-4.7" }
 *     },
 *     "active": "default",
 *     "overrides": { "hermes": "zai/glm-4.6" }   // 可选: 按插件微调, 不随方案变
 *   }
 *
 * 用法:
 *   /models                    — 看当前方案 + 各目标生效值
 *   /models <profile>          — 切换方案(写配置 + 热应用到所有目标)
 *   /models set <target> <id>  — 单独微调某目标(覆盖层, 方案切换不冲掉)
 *   /models reset <target>     — 清除某目标的 override, 回归方案值
 *
 * 目标(target)系统可扩展: 每个目标声明如何应用(热)或需重启, 新插件接入=加一个 apply 函数。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi/agent/model-profiles.json");

// ─── 配置模型 ───

interface Profile {
	main: string; // "provider/id"
	thinking?: string; // 主模型思考档
	aux: string; // 后台/分类器小模型 "provider/id"
	[label: string]: unknown; // 允许扩展字段
}

interface ProfilesConfig {
	profiles: Record<string, Profile>;
	active: string;
	overrides: Record<string, string>; // target -> model id, 优先于方案
}

function loadConfig(): ProfilesConfig | null {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProfilesConfig;
	} catch {
		return null;
	}
}

function saveConfig(cfg: ProfilesConfig): void {
	writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// ─── 目标注册表: 新插件接入点 ───

interface Target {
	label: string;
	/** 从方案解析该目标的模型 id */
	resolve(profile: Profile): string;
	/** 应用模型到实际配置。返回描述; throw/报错则提示需手动 */
	apply?: (modelId: string, ctx: ExtensionContext) => Promise<string>;
	/** 声明"需重启才生效"的静态应用(写文件) */
	applyNote?: string;
}

function splitId(id: string): { provider: string; model: string } | null {
	const i = id.indexOf("/");
	return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
}

/** 写 JSON 文件的指定字段(保留其他键), 返回是否变更 */
function patchJson(path: string, patch: (obj: Record<string, unknown>) => void): boolean {
	if (!existsSync(path)) return false;
	try {
		const obj = JSON.parse(readFileSync(path, "utf-8"));
		const before = JSON.stringify(obj);
		patch(obj);
		const after = JSON.stringify(obj);
		if (after === before) return false;
		writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

const AGENT = join(homedir(), ".pi/agent");

const TARGETS: Record<string, Target> = {
	// 主对话模型: preset 体系热切 + default 持久化
	main: {
		label: "主对话模型 (+presets.json main 档)",
		resolve: (p) => p.main,
		apply: async (modelId, ctx) => {
			const parts = splitId(modelId);
			if (!parts) throw new Error(`bad id: ${modelId}`);
			// 1) 热切换当前会话
			const model = ctx.modelRegistry.find(parts.provider, parts.model);
			if (!model) throw new Error(`registry 找不到 ${modelId}`);
			const pi = (ctx as unknown as { pi?: { setModel: (m: unknown) => Promise<boolean> } }).pi;
			// ctx 无 setModel; 用 sendUserMessage 不可靠, 落到 settings + preset
			// 2) 持久化 default
			const changed = patchJson(join(AGENT, "settings.json"), (o) => {
				o.defaultProvider = parts.provider;
				o.defaultModel = parts.model;
			});
			// 3) 同步 presets.json 的 main 档
			patchJson(join(AGENT, "presets.json"), (o) => {
				if (o.main) {
					o.main.provider = parts.provider;
					o.main.model = parts.model;
				}
			});
			return `${changed ? "settings.json 已更新(重启后为默认)" : "settings 无变化"}; presets.main 已同步; 当前会话请用 /preset main 热切`;
		},
	},
	// automode 分类器: 写配置 + 提示 reload
	automode: {
		label: "pi-automode 分类器 (/automode reload 生效)",
		resolve: (p) => p.aux,
		apply: async (modelId) => {
			const changed = patchJson(join(AGENT, "automode.json"), (o) => {
				o.autoMode = { ...(o.autoMode as object), classifierModel: modelId };
			});
			return changed ? "automode.json 已更新, 跑 /automode reload" : "automode.json 无变化";
		},
	},
	// hermes 后台 LLM: 写配置 + 提示 reload
	hermes: {
		label: "pi-hermes-memory 后台 LLM (/memory-reload 生效)",
		resolve: (p) => p.aux,
		apply: async (modelId) => {
			const changed = patchJson(join(AGENT, "hermes-memory-config.json"), (o) => {
				o.llmModelOverride = modelId;
			});
			return changed ? "hermes 配置已更新, 跑 /memory-reload" : "hermes 配置无变化";
		},
	},
	// subagents 全局默认模型: 写 settings.json 的 subagents.defaultModel
	// (agent 级覆盖/frontmatter 优先级更高, 这里只动兑底层)
	subagents: {
		label: "子代理默认模型 (重启 pi 生效)",
		resolve: (p) => p.aux,
		apply: async (modelId) => {
			const changed = patchJson(join(AGENT, "settings.json"), (o) => {
				const sa = (o.subagents ?? {}) as Record<string, unknown>;
				sa.defaultModel = modelId;
				o.subagents = sa;
			});
			return changed
				? `settings.json subagents.defaultModel → ${modelId} (重启生效; agent 级覆盖不变)`
				: "subagents.defaultModel 无变化";
		},
	},
	// subagents 重型 agent 组: 方案字段 heavy 控制, 缺省回落 main
	// 只改 agentOverrides 的 model 字段, 不碰 thinking/budget 等其他覆盖
	heavy: {
		label: "子代理重型档 reviewer/oracle (重启生效)",
		resolve: (p) => (typeof p.heavy === "string" ? (p.heavy as string) : p.main),
		apply: async (modelId) => {
			const changed = patchJson(join(AGENT, "settings.json"), (o) => {
				const sa = (o.subagents ?? {}) as Record<string, unknown>;
				const ov = (sa.agentOverrides ?? {}) as Record<string, Record<string, unknown>>;
				for (const agent of ["reviewer", "oracle"]) {
					ov[agent] = { ...ov[agent], model: modelId };
				}
				sa.agentOverrides = ov;
				o.subagents = sa;
			});
			return changed ? `reviewer/oracle → ${modelId} (重启生效)` : "重型档无变化";
		},
	},
};

// ─── 应用逻辑 ───

function resolveTargetValue(cfg: ProfilesConfig, targetKey: string): string | null {
	const profile = cfg.profiles[cfg.active];
	if (!profile) return null;
	if (cfg.overrides?.[targetKey]) return cfg.overrides[targetKey];
	return TARGETS[targetKey]?.resolve(profile) ?? null;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("models", {
		description: "模型方案管理: /models [profile] | set/reset <target> <id>",
		handler: async (args, ctx) => {
			const cfg = loadConfig();
			if (!cfg) {
				ctx.ui.notify(`配置文件缺失或损坏: ${CONFIG_PATH}`, "error");
				return;
			}
			const parts = args.trim().split(/\s+/).filter(Boolean);

			// /models — 总览
			if (parts.length === 0) {
				const lines = [`方案: ${cfg.active}`];
				const p = cfg.profiles[cfg.active];
				if (p) lines.push(`  main=${p.main} thinking=${p.thinking ?? "-"} aux=${p.aux}`);
				lines.push("目标生效值:");
				for (const [k, t] of Object.entries(TARGETS)) {
					const v = resolveTargetValue(cfg, k);
					const ov = cfg.overrides?.[k] ? " (override)" : "";
					lines.push(`  ${k.padEnd(9)} ${v ?? "?"}${ov}  — ${t.label}`);
				}
				lines.push(`可选方案: ${Object.keys(cfg.profiles).join(", ")}`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// /models set <target> <id> — 微调覆盖
			if (parts[0] === "set") {
				const [, tk, id] = parts;
				if (!tk || !id || !TARGETS[tk]) {
					ctx.ui.notify(
						`用法: /models set <${Object.keys(TARGETS).join("|")}> <provider/id>`,
						"error",
					);
					return;
				}
				cfg.overrides = { ...cfg.overrides, [tk]: id };
				saveConfig(cfg);
				const msg = await TARGETS[tk].apply!(id, ctx);
				ctx.ui.notify(`override ${tk} → ${id}\n${msg}`, "info");
				return;
			}

			// /models reset <target> — 清除覆盖
			if (parts[0] === "reset") {
				const [, tk] = parts;
				if (!tk || !cfg.overrides?.[tk]) {
					ctx.ui.notify(
						`无此 override。现有: ${Object.keys(cfg.overrides ?? {}).join(", ") || "无"}`,
						"error",
					);
					return;
				}
				delete cfg.overrides[tk];
				saveConfig(cfg);
				const v = resolveTargetValue(cfg, tk);
				const msg = v ? await TARGETS[tk].apply!(v, ctx) : "(方案无此值)";
				ctx.ui.notify(`已清除 ${tk}, 回归方案值 ${v}\n${msg}`, "info");
				return;
			}

			// /models <profile> — 切方案
			const name = parts[0];
			if (!cfg.profiles[name]) {
				ctx.ui.notify(`未知方案: ${name}。可选: ${Object.keys(cfg.profiles).join(", ")}`, "error");
				return;
			}
			cfg.active = name;
			saveConfig(cfg);
			const results: string[] = [`方案切换 → ${name}`];
			for (const [k, t] of Object.entries(TARGETS)) {
				const v = resolveTargetValue(cfg, k);
				if (!v || !t.apply) continue;
				try {
					results.push(`${k}: ${await t.apply(v, ctx)}`);
				} catch (err) {
					results.push(`${k}: 应用失败 — ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			ctx.ui.notify(results.join("\n"), "info");
		},
	});
}
