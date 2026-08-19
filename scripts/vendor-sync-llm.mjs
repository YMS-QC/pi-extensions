#!/usr/bin/env node
/**
 * vendor-sync-llm.mjs — 上游 vendor 变化收集 + LLM 评审（只读，不修改工作树）
 *
 * 前置: 仓库已配置并 fetch 好上游 remote（见 .github/workflows/vendor-sync.yml 或手工 fetch）。
 * 输出: --out 目录（默认 .vendor-sync）
 *   verdict.json  机器可读判定，overall ∈ uptodate|adopt|mixed|hold|manual
 *   report.md     人读中文报告
 *   context.json  原始收集数据
 *   prompts.md    发给 LLM 的完整 prompt（调试/审计用）
 *
 * 用法:
 *   node scripts/vendor-sync-llm.mjs [--out DIR] [--only a,b] [--dry-run] [--no-llm] [--self-test]
 * 环境变量:
 *   LLM_BASE_URL  默认 https://api.deepseek.com/v1（OpenAI 兼容）
 *   LLM_MODEL     默认 deepseek-v4-flash（快且便宜，适合每日自动跑；要更强改 deepseek-v4-pro）
 *   LLM_API_KEY   必填（--dry-run / --no-llm / --self-test 除外）
 *
 * 安全边界: LLM 输出只做判定与文案，绝不执行；解析失败一律降级 manual（fail-safe）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const VENDORS = [
	{
		name: "pi-telegram",
		remote: "up-telegram",
		url: "https://github.com/llblab/pi-telegram",
		branch: "main",
		prefix: "packages/stack/pi-telegram",
	},
	{
		name: "pi-automode",
		remote: "up-automode",
		url: "https://github.com/czottmann/pi-automode",
		branch: "main",
		prefix: "packages/stack/pi-automode",
	},
	{
		name: "pi-hermes-memory",
		remote: "up-hermes",
		url: "https://github.com/chandra447/pi-hermes-memory",
		branch: "main",
		prefix: "packages/stack/pi-hermes-memory",
	},
];

const DIFF_CAP = 250_000;
const LOCAL_DIFF_CAP = 40_000;
const STAT_CAP = 4_000;
const COMMIT_LIST_CAP = 200;
const LLM_TIMEOUT_MS = 120_000;
const LLM_RETRIES = 2;
const VALID_VERDICTS = new Set(["adopt", "hold", "manual"]);

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).trim();
}

/** 从根 SOURCES.md 提取该包在案的补丁/基线记载行，找不到返回空数组。 */
function readSourcesNote(name) {
	try {
		return readFileSync("SOURCES.md", "utf8")
			.split("\n")
			.filter((l) => l.includes("|") && l.includes(`\`${name}\``))
			.map((l) => l.trim());
	} catch {
		return [];
	}
}

function cap(text, limit, label) {
	if (text.length <= limit) {
		return { text, truncated: false };
	}
	const note = `... [${label}已截断: 原始 ${text.length} 字符，仅保留前 ${limit}]`;
	return { text: `${text.slice(0, limit)}\n${note}`, truncated: true };
}

function collect(v) {
	const ref = `${v.remote}/${v.branch}`;
	try {
		git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	} catch {
		return {
			...v,
			status: "error",
			error: `本地引用 ${ref} 不存在，请先 git fetch ${v.remote} ${v.branch}`,
		};
	}
	const newCommits = git(["log", "--format=%h|%s", `HEAD..${ref}`])
		.split("\n")
		.filter(Boolean);
	if (newCommits.length === 0) {
		return { ...v, status: "uptodate", newCommits: [] };
	}
	const mergeBase = git(["merge-base", "HEAD", ref]);
	const changedFiles = git(["diff", "--name-only", mergeBase, ref]).split("\n").filter(Boolean);
	// 上游活跃度信号：近期 merged PR 数量（>0 说明上游愿意合并外部贡献，协作正常；
	// 0 可能只是 squash 工作流，不做负面解读）
	const recentSubjects = git(["log", "--format=%s", "-n", "60", ref]).split("\n");
	const upstreamActivity = {
		sampled: recentSubjects.length,
		mergedPRs: recentSubjects.filter((s) => /^Merge pull request #\d+/.test(s)).length,
	};
	// 上游历史在 DAG 里是根布局，直接用 pathspec 会把旧侧清零（整包误判为新增）；
	// 因此用 tree 对象直接比较: <merge-base>根树 vs HEAD:<prefix>子树，输出为上游根路径视角。
	const localDiffText = git(["diff", mergeBase, `HEAD:${v.prefix}`]);
	return {
		...v,
		status: "changed",
		mergeBase,
		newCommitTotal: newCommits.length,
		newCommits: newCommits.slice(0, COMMIT_LIST_CAP),
		commitListTruncated: newCommits.length > COMMIT_LIST_CAP,
		upstreamDiff: cap(git(["diff", mergeBase, ref]), DIFF_CAP, "上游 diff"),
		stat: cap(git(["diff", "--stat", mergeBase, ref]), STAT_CAP, "stat"),
		changedFileCount: changedFiles.length,
		licenseChanged: changedFiles.some((f) => /^(LICEN[SC]E|COPYING)/i.test(f)),
		pkgJsonChanged: changedFiles.includes("package.json"),
		upstreamActivity,
		// fork 仓时代的补丁提交是根布局，pathspec 抓不到，净效果已在上面的 tree diff 里；
		// 这里仅收集本仓内直接改 prefix 的提交，另从 SOURCES.md 补记载。
		localCommits: git(["log", "--format=%h|%s", `${ref}..HEAD`, "--", v.prefix])
			.split("\n")
			.filter(Boolean),
		sourcesNote: readSourcesNote(v.name),
		localDiff: cap(localDiffText, LOCAL_DIFF_CAP, "本地补丁 diff"),
	};
}

const SYSTEM_PROMPT = `你是私有 monorepo 的 vendor 同步评审员。仓库用 git subtree 收纳第三方扩展，
本地在 subtree 之上维护少量自有补丁。现给出某包的上游新变化与本地补丁，判断本次是否自动并入。

总体策略是**乐观并入**：上游是我们在用的活跃项目，默认信任其常规演进。
文本冲突由 subtree merge 解决，行为回归由合并后的完整检查门禁兼底，
这两者都不是 hold 的理由。adopt 是默认判定。

- adopt（默认）：bugfix、新特性、重构、依赖升级、版本发布、大版本跨度、
  与本地补丁有交叠但语义兼容。上游等效实现了本地补丁时也判 adopt，
  并在 superseded_patches 里列出，便于我们之后删本地补丁或给上游提 PR。
- hold（仅限原则性冲突，即使检查通过也不该进仓）：许可证更换或新增限制性条款；
  上游删除/根本改变了本地补丁依赖的机制且非等效实现（合并会静默废掉我们的补丁）；
  可疑代码（混淆注入、数据外传、后门）；上游停维且变更质量可疑。
- manual（仅限信息不足）：提交列表与 diff 都无法判断意图，无法排除命中上述 hold 条件。

注意：diff 截断本身不是 manual 的充分理由——若提交列表与 stat 显示常规演进，仍应 adopt，
并在 risks 里注明截断供人事后抽查。宁可 adopt 也不要苛求。

输出必须是单个 JSON 对象，禁止输出 JSON 之外的任何文字或代码块围栏:
{"verdict":"adopt|hold|manual","summary":"一句话中文摘要",
 "reasons":["中文理由"],"superseded_patches":["被上游等效覆盖的本地补丁，无则空数组"],
 "risks":["风险点，无则空数组"],"recommendation":"中文后续动作建议"}`;

function buildUserPrompt(p) {
	const lines = [];
	lines.push("## 包信息");
	lines.push(`- 名称: ${p.name}`);
	lines.push(`- 上游: ${p.url} (${p.branch})`);
	lines.push(`- 本仓 subtree 路径: ${p.prefix}`);
	lines.push(
		`- 上游活跃度: 最近 ${p.upstreamActivity.sampled} 个提交中 ${p.upstreamActivity.mergedPRs} 个为 merged PR（上游愿意合并外部贡献的信号；0 可能是 squash 工作流）`,
	);
	lines.push(`- 上游许可证文件变更: ${p.licenseChanged ? "是（必须重点审查）" : "否"}`);
	lines.push(`- 上游 package.json 变更: ${p.pkgJsonChanged ? "是（注意依赖与入口变化）" : "否"}`);
	lines.push(`- 上游变更文件数: ${p.changedFileCount}`);
	lines.push("");
	const listed = p.commitListTruncated
		? `（共 ${p.newCommitTotal} 个，仅列前 ${COMMIT_LIST_CAP} 个）`
		: "";
	lines.push(`## 上游新提交${listed}`);
	for (const c of p.newCommits) {
		lines.push(`- ${c.replace("|", " ")}`);
	}
	lines.push("");
	lines.push("## 上游变更统计");
	lines.push("```");
	lines.push(p.stat.text);
	lines.push("```");
	lines.push("");
	lines.push("## 上游完整 diff");
	lines.push("```diff");
	lines.push(p.upstreamDiff.text);
	lines.push("```");
	lines.push("");
	lines.push("## SOURCES.md 在案记载（基线与补丁）");
	if (p.sourcesNote.length === 0) {
		lines.push("- （未找到）");
	} else {
		for (const l of p.sourcesNote) {
			lines.push(`- ${l}`);
		}
	}
	lines.push("");
	lines.push("## 本地补丁提交（仅本仓直接提交，供重叠判断）");
	if (p.localCommits.length === 0) {
		lines.push("- （无）");
	} else {
		for (const c of p.localCommits) {
			lines.push(`- ${c.replace("|", " ")}`);
		}
	}
	lines.push("");
	lines.push("## 本地补丁相对上游基线的净 diff（上游根路径视角）");
	lines.push("```diff");
	lines.push(p.localDiff.text);
	lines.push("```");
	return lines.join("\n");
}

async function callLlm(base, key, model, messages) {
	const endpoint = `${base.replace(/\/+$/, "")}/chat/completions`;
	let lastError;
	for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
				body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 8000 }),
				signal: controller.signal,
			});
			if (!res.ok) {
				throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
			}
			const data = await res.json();
			const content = data?.choices?.[0]?.message?.content;
			if (typeof content !== "string" || !content.trim()) {
				throw new Error("LLM 返回空内容");
			}
			return content;
		} catch (err) {
			lastError = err;
			if (attempt < LLM_RETRIES) {
				await new Promise((r) => {
					setTimeout(r, 3000 * (attempt + 1));
				});
			}
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastError;
}

function parseVerdict(text) {
	const raw = text
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("输出中未找到 JSON 对象");
	}
	const obj = JSON.parse(raw.slice(start, end + 1));
	if (!VALID_VERDICTS.has(obj.verdict)) {
		throw new Error(`verdict 非法: ${String(obj.verdict)}`);
	}
	const asArray = (x) => {
		if (Array.isArray(x)) {
			return x.map(String);
		}
		return typeof x === "string" && x ? [x] : [];
	};
	return {
		verdict: obj.verdict,
		summary: String(obj.summary ?? "").slice(0, 500),
		reasons: asArray(obj.reasons),
		superseded_patches: asArray(obj.superseded_patches ?? obj.supersededPatches),
		risks: asArray(obj.risks),
		recommendation: String(obj.recommendation ?? "").slice(0, 500),
	};
}

function manualFallback(summary, reasons) {
	return {
		verdict: "manual",
		summary,
		reasons,
		superseded_patches: [],
		risks: [],
		recommendation: "按 report.md 手工执行 ./update-vendors.sh 并人工核对",
	};
}

function overallOf(packages) {
	const changed = packages.filter((p) => p.status === "changed");
	if (changed.length === 0) {
		return "uptodate";
	}
	const verdicts = new Set(changed.map((p) => p.verdict));
	if (verdicts.size === 1 && verdicts.has("adopt")) {
		return "adopt";
	}
	if (verdicts.has("adopt")) {
		return "mixed";
	}
	return verdicts.has("manual") ? "manual" : "hold";
}

function renderReport(state) {
	const { packages, overall, mode, generatedAt } = state;
	const lines = [];
	lines.push("# vendor-sync 评审报告");
	lines.push("");
	lines.push(`- 时间: ${generatedAt}`);
	lines.push(`- 模式: ${mode}`);
	lines.push(`- 总体判定: **${overall}**`);
	lines.push("");
	lines.push("| 包 | 状态 | 判定 |");
	lines.push("|---|---|---|");
	for (const p of packages) {
		const status = {
			changed: `${p.newCommitTotal} 个新提交`,
			uptodate: "已是最新",
			error: "收集失败",
		}[p.status];
		lines.push(`| ${p.name} | ${status ?? p.status} | ${p.verdict ?? "-"} |`);
	}
	for (const p of packages) {
		lines.push("");
		lines.push(`## ${p.name}`);
		if (p.status === "error") {
			lines.push(`- 收集失败: ${p.error}`);
			continue;
		}
		if (p.status === "uptodate") {
			lines.push("- 上游无新提交。");
			continue;
		}
		lines.push(`- 判定: **${p.verdict}** — ${p.summary}`);
		if (p.commitListTruncated) {
			lines.push(`- 上游新提交: 共 ${p.newCommitTotal} 个（列表截断至 ${COMMIT_LIST_CAP}）`);
		}
		if (p.upstreamDiff.truncated || p.localDiff.truncated) {
			lines.push("- ⚠️ diff 被截断，判定可能不完整，建议人工复核完整 diff。");
		}
		if (p.reasons.length > 0) {
			lines.push("");
			lines.push("### 理由");
			for (const r of p.reasons) {
				lines.push(`- ${r}`);
			}
		}
		if (p.superseded_patches.length > 0) {
			lines.push("");
			lines.push("### 可能被上游等效覆盖的本地补丁");
			for (const r of p.superseded_patches) {
				lines.push(`- ${r}`);
			}
		}
		if (p.risks.length > 0) {
			lines.push("");
			lines.push("### 风险");
			for (const r of p.risks) {
				lines.push(`- ${r}`);
			}
		}
		lines.push("");
		lines.push(`建议: ${p.recommendation}`);
		lines.push("");
		lines.push("上游变更统计:");
		lines.push("```");
		lines.push(p.stat.text);
		lines.push("```");
	}
	lines.push("");
	lines.push("---");
	const action = {
		uptodate: "上游无变化，本次不产生提交。",
		adopt: "乐观并入：工作流将执行 subtree pull → npm run check → 通过后自动 push main。",
		mixed: "工作流只自动并入判定 adopt 的包；其余见上，等人工处理。",
		hold: "存在需人审的包，本次不自动并入，待 issue 跟进。",
		manual: "信息不足或失败，本次不自动并入，待 issue 跟进。",
	}[overall];
	lines.push(`后续动作: ${action}`);
	lines.push("手工处理参考: ./update-vendors.sh");
	return lines.join("\n");
}

function selfTest() {
	const good = parseVerdict(
		'```json\n{"verdict":"adopt","summary":"s","reasons":["r"],"risks":[]}\n```',
	);
	if (good.verdict !== "adopt" || good.reasons.length !== 1) {
		throw new Error("parseVerdict 正常用例失败");
	}
	const wrapped = parseVerdict('前言 {"verdict":"hold","summary":"s"} 后记');
	if (wrapped.verdict !== "hold") {
		throw new Error("parseVerdict 包裹用例失败");
	}
	let threw = false;
	try {
		parseVerdict('{"verdict":"weird"}');
	} catch {
		threw = true;
	}
	if (!threw) {
		throw new Error("parseVerdict 非法 verdict 未拒绝");
	}
	const capped = cap("x".repeat(100), 10, "t");
	if (!capped.truncated || capped.text.length > 60) {
		throw new Error("cap 用例失败");
	}
	const report = renderReport({
		generatedAt: "test",
		mode: "self-test",
		overall: "adopt",
		packages: [
			{
				name: "demo",
				status: "changed",
				newCommitTotal: 1,
				verdict: "adopt",
				summary: "s",
				reasons: ["r"],
				superseded_patches: [],
				risks: [],
				recommendation: "ok",
				upstreamDiff: { text: "d", truncated: false },
				localDiff: { text: "d", truncated: false },
				stat: { text: "1 file", truncated: false },
				commitListTruncated: false,
			},
		],
	});
	if (!report.includes("demo") || !report.includes("adopt")) {
		throw new Error("renderReport 用例失败");
	}
	console.log("self-test PASS");
}

async function main() {
	const args = process.argv.slice(2);
	const flag = (n) => args.includes(n);
	if (flag("--self-test")) {
		selfTest();
		return;
	}
	const outIdx = args.indexOf("--out");
	const outDir = outIdx !== -1 ? args[outIdx + 1] : ".vendor-sync";
	const onlyIdx = args.indexOf("--only");
	const only = onlyIdx !== -1 ? args[onlyIdx + 1].split(",").map((s) => s.trim()) : null;
	const dryRun = flag("--dry-run");
	const noLlm = flag("--no-llm");
	const mode = dryRun ? "dry-run" : noLlm ? "--no-llm（跳过 LLM，机械同步）" : "LLM 评审";
	const base = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
	const model = process.env.LLM_MODEL || "deepseek-v4-flash";
	const apiKey = process.env.LLM_API_KEY || "";
	if (!dryRun && !noLlm && !apiKey) {
		console.error("缺少 LLM_API_KEY（或使用 --dry-run / --no-llm）");
		process.exit(2);
	}

	const vendors = only ? VENDORS.filter((v) => only.includes(v.name)) : VENDORS;
	if (vendors.length === 0) {
		console.error(`--only 未匹配任何包: ${only.join(",")}`);
		process.exit(2);
	}

	const prompts = [`===== SYSTEM PROMPT =====\n${SYSTEM_PROMPT}`];
	const packages = [];
	for (const v of vendors) {
		const p = collect(v);
		if (p.status !== "changed") {
			p.verdict = p.status === "uptodate" ? "uptodate" : "manual";
			packages.push(p);
			continue;
		}
		const userPrompt = buildUserPrompt(p);
		prompts.push(`===== ${p.name} =====\n${userPrompt}`);
		if (noLlm) {
			Object.assign(p, manualNoLlm());
		} else if (dryRun) {
			Object.assign(
				p,
				manualFallback("dry-run：未调用 LLM", ["--dry-run 模式仅收集与渲染，不产生判定"]),
			);
		} else {
			try {
				const content = await callLlm(base, apiKey, model, [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: userPrompt },
				]);
				prompts.push(`----- ${p.name} LLM 响应 -----\n${content}`);
				Object.assign(p, parseVerdict(content));
			} catch (err) {
				console.error(`[warn] ${p.name} LLM 调用/解析失败: ${err.message}`);
				Object.assign(p, manualFallback("LLM 调用或解析失败，降级人工", [err.message]));
			}
		}
		packages.push(p);
	}

	const state = {
		generatedAt: new Date().toISOString(),
		mode,
		overall: overallOf(packages),
		packages: packages.map((p) => {
			const { stat, upstreamDiff, localDiff, ...rest } = p;
			return {
				...rest,
				upstreamDiffTruncated: upstreamDiff?.truncated ?? false,
				localDiffTruncated: localDiff?.truncated ?? false,
			};
		}),
	};
	mkdirSync(outDir, { recursive: true });
	writeFileSync(path.join(outDir, "verdict.json"), `${JSON.stringify(state, null, 2)}\n`);
	writeFileSync(path.join(outDir, "report.md"), `${renderReport({ ...state, packages })}\n`);
	writeFileSync(path.join(outDir, "prompts.md"), `${prompts.join("\n\n")}\n`);
	console.log(`overall: ${state.overall}`);
	console.log(`报告: ${path.join(outDir, "report.md")}`);
}

function manualNoLlm() {
	return {
		verdict: "adopt",
		summary: "--no-llm 机械同步：跳过评审，仅依赖 subtree merge 与 npm run check 兜底",
		reasons: ["调用方显式指定 --no-llm"],
		superseded_patches: [],
		risks: ["未做 LLM 评审，破坏性变更只能靠 check 门禁拦截"],
		recommendation: "合并后人工抽查 diff",
	};
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
