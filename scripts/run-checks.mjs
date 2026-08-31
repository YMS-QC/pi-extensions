#!/usr/bin/env node

import concurrently from "concurrently";

const checks = ["biome:check", "check:boundaries", "typecheck", "test", "stack-checks"];

console.log(`Running checks in parallel: ${checks.join(", ")}`);
const { result } = concurrently(
	checks.map((check) => ({ command: `npm:${check}`, name: check })),
	{ prefix: "name", prefixColors: ["auto"] },
);

try {
	await result;
} catch {
	process.exitCode = 1;
}
