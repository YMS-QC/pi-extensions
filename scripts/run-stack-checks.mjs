#!/usr/bin/env node
/**
 * run-stack-checks.mjs — vendored 包（packages/stack/*）逐包自管检查。
 *
 * 这些包不进 root npm workspace：每个包自带上游的 package.json + package-lock.json，
 * 在包目录内用自己的 lockfile 安装、跑自己的脚本（typecheck/check/test）。
 * 这样 root lockfile 与上游依赖变化彻底解耦，subtree 合并后门禁不会因 root lock 失配误报。
 *
 * 安装策略:
 *   - 无 node_modules → npm ci（用 vendored lockfile，确定性，CI 走这条路）
 *   - 已有 node_modules → npm install --no-save --no-package-lock（本地增量，不写 vendored 树）
 * 环境变量:
 *   STACK_CHECK_SKIP_INSTALL=1  跳过安装（本地已装好时加速）
 *
 * --install-only  只装依赖、不跑检查，且跳过已有 node_modules 的包。
 *   被 root package.json 的 postinstall 调用：pi 对 git: 包做 reconciliation 时
 *   （reset + clean + root npm install）会连带触发，从而自动补齐 vendored 依赖，
 *   避免 stack 扩展在 pi 运行时副本里报 Cannot find module。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stackDir = path.join(root, "packages", "stack");
const installOnly = process.argv.includes("--install-only");

// 各包要跑的脚本（用上游自己的定义，名字不同的在这里映射；未知包默认 typecheck+test）
const SCRIPTS_BY_PACKAGE = {
	"pi-telegram": ["typecheck", "test"],
	"pi-automode": ["typecheck", "test"],
	// hermes 的 check = ensure-dev 守卫 + tsc；test = ensure-dev + run-all.sh
	"pi-hermes-memory": ["check", "test"],
};

const packages = fs
	.readdirSync(stackDir, { withFileTypes: true })
	.filter(
		(entry) =>
			entry.isDirectory() && fs.existsSync(path.join(stackDir, entry.name, "package.json")),
	)
	.map((entry) => entry.name)
	.sort();

if (packages.length === 0) {
	console.log("stack-checks: no vendored packages found");
	process.exit(0);
}

let failed = 0;
for (const name of packages) {
	const dir = path.join(stackDir, name);
	const scripts = SCRIPTS_BY_PACKAGE[name] ?? ["typecheck", "test"];
	const hasModules = fs.existsSync(path.join(dir, "node_modules"));

	if (installOnly && hasModules) {
		console.log(`\n=== stack ${name}: node_modules 已存在，跳过 (install-only)`);
		continue;
	}

	console.log(`\n=== stack ${name} (${installOnly ? "install-only" : scripts.join(", ")})`);

	if (process.env.STACK_CHECK_SKIP_INSTALL === "1") {
		console.log("  [skip-install] STACK_CHECK_SKIP_INSTALL=1");
	} else {
		const installArgs = hasModules
			? ["install", "--no-save", "--no-audit", "--no-fund"]
			: ["ci", "--no-audit", "--no-fund"];
		if (run("npm", installArgs, dir) !== 0) {
			failed++;
			continue;
		}
	}

	if (installOnly) {
		continue;
	}

	let ok = true;
	for (const script of scripts) {
		if (run("npm", ["run", "--if-present", script], dir) !== 0) {
			ok = false;
		}
	}
	if (!ok) {
		failed++;
	}
}

if (failed > 0) {
	console.error(`\nstack-checks: ${failed} package(s) failed`);
	process.exit(1);
}
console.log(
	installOnly
		? `\nstack-install: dependencies present for all ${packages.length} package(s)`
		: `\nstack-checks: all ${packages.length} package(s) passed`,
);

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.error) {
		console.error(result.error.message);
		return 1;
	}
	return result.status ?? 1;
}
