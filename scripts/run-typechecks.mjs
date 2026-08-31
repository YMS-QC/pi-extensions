#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// root workspace 目前可能没有任何含 package.json 的自有包（vendored 包不进 workspace），
// 此时 npm --workspaces 会报 "No workspaces found!"，直接视为通过。
const hasWorkspace = fs
	.readdirSync(path.join(root, "packages"), { withFileTypes: true })
	.some(
		(entry) =>
			entry.isDirectory() &&
			entry.name !== "stack" &&
			fs.existsSync(path.join(root, "packages", entry.name, "package.json")),
	);
if (!hasWorkspace) {
	console.log("typecheck: no workspace packages with manifests, nothing to do");
	process.exit(0);
}

runNpm(["--workspaces", "--if-present", "run", "typecheck"]);

function runNpm(args) {
	const command = process.env.npm_execpath
		? process.execPath
		: process.platform === "win32"
			? "npm.cmd"
			: "npm";
	const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
	const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}
