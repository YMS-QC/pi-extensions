import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	deterministicHardDeny,
	isRootHomeOrSystemPath,
} from "../extensions/auto-mode.ts";

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

test("deterministic hard deny protects global Pi extensions and settings", () => {
	const agentDir = join(os.homedir(), ".pi/agent");
	for (const path of [
		join(agentDir, "extensions/auto-mode.ts"),
		join(os.homedir(), ".PI/AGENT/EXTENSIONS/auto-mode.ts"),
		join(agentDir, "settings.json"),
		join(agentDir, "settings/providers.json"),
	]) {
		assert.match(
			deterministicHardDeny("write", { path }, "/tmp/project") ?? "",
			/safety-control/,
			path,
		);
	}
	assert.match(
		deterministicHardDeny(
			"edit",
			{ path: join(agentDir, "settings.json") },
			"/tmp/project",
		) ?? "",
		/safety-control/,
	);

	assert.equal(
		deterministicHardDeny(
			"write",
			{ path: "/tmp/project/src/app.ts" },
			"/tmp/project",
		),
		undefined,
	);
});

test("deterministic hard deny resolves symlinks to global Pi extensions", () => {
	const project = mkdtempSync(join(os.tmpdir(), "pi-automode-global-extension-link-"));
	try {
		const link = join(project, "linked-extensions");
		symlinkSync(join(os.homedir(), ".pi/agent/extensions"), link);
		assert.match(
			deterministicHardDeny(
				"write",
				{ path: join(link, "auto-mode.ts") },
				project,
			) ?? "",
			/safety-control/,
		);
	} finally {
		rmSync(project, { recursive: true, force: true });
	}
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

test("AST hard-deny checks inspect nested and background commands", () => {
	for (const command of [
		'echo "$(git config --global http.sslVerify false)"',
		"cat <(git config --global http.sslVerify false)",
		"echo safe & git config --global http.sslVerify false",
		"if test -n x; then git config --global http.sslVerify false; fi",
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/TLS/,
			command,
		);
	}
});

test("AST hard-deny checks inspect literal shell and eval wrappers", () => {
	for (const command of [
		`bash -c 'rm -rf /'`,
		`sh -c 'rm -rf /'`,
		`eval 'rm -rf /'`,
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny checks inspect literal shells behind transparent dispatch wrappers", () => {
	for (const command of [
		`command bash -c 'rm -rf /'`,
		`command -p /bin/bash -c 'rm -rf /'`,
		`exec sh -c 'rm -rf /'`,
		`exec -a worker /bin/sh -c 'rm -rf /'`,
		`env bash -c 'rm -rf /'`,
		`env -i MODE=test /bin/bash -c 'rm -rf /'`,
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny checks inspect commands behind transparent dispatch wrappers", () => {
	for (const command of [
		"command rm -rf /",
		"command -p /bin/rm -rf /",
		"exec rm -rf /",
		"exec -a worker /bin/rm -rf /",
		"env rm -rf /",
		"env -- MODE=test rm -rf /",
		"env 1=x rm -rf /",
		"env -i MODE=test /bin/rm -rf /",
		"env MODE=test command rm -rf /",
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny parses rm options and operands around the option delimiter", () => {
	const cwd = mkdtempSync(join(os.tmpdir(), "pi-automode-rm-options-"));
	try {
		symlinkSync("/", join(cwd, "-root"));
		assert.match(
			deterministicHardDeny(
				"bash",
				{ command: "rm -rf -- -root/etc" },
				cwd,
			) ?? "",
			/irreversible deletion/,
		);
		assert.equal(
			deterministicHardDeny(
				"bash",
				{ command: "rm -- --recursive /" },
				cwd,
			),
			undefined,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("AST hard-deny checks normalize absolute executable paths", () => {
	assert.match(
		deterministicHardDeny("bash", { command: "/bin/rm -rf /" }, process.cwd()) ?? "",
		/irreversible deletion/,
	);
	assert.match(
		deterministicHardDeny(
			"bash",
			{ command: "/usr/bin/git config --global http.sslVerify false" },
			process.cwd(),
		) ?? "",
		/TLS/,
	);
});

test("AST hard-deny checks protect recursive rm variants and system roots", () => {
	for (const command of [
		"rm -Rf /",
		"rm --recurs /",
		"rm -rf ~",
		"rm -rf /home",
		"rm -rf /proc",
		"rm -rf /root",
		"rm -rf /run",
		"rm -rf /System",
		"rm -rf /Library",
		"rm -rf ~root",
		`rm -rf ~root/"child"`,
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
			/irreversible deletion/,
			command,
		);
	}
});

test("AST hard-deny checks leave literal tildes and application roots to review", () => {
	for (const command of [
		`rm -rf "~"`,
		"rm -rf \\~",
		`rm -rf ~"root"`,
		"rm -- /",
		"rm -rf /opt/app",
		"rm -rf /srv/app",
		"git push",
	]) {
		assert.equal(
			deterministicHardDeny("bash", { command }, process.cwd()),
			undefined,
			command,
		);
	}
});

test(
	"AST hard-deny checks canonicalize case aliases on case-insensitive macOS volumes",
	{ skip: process.platform !== "darwin" || !existsSync("/system") },
	() => {
		const commands = ["rm -rf /system", "rm -rf /library"];
		const lowerHome = os.homedir().toLowerCase();
		if (lowerHome !== os.homedir() && existsSync(lowerHome)) {
			commands.push(`rm -rf ${lowerHome}`);
		}
		for (const command of commands) {
			assert.match(
				deterministicHardDeny("bash", { command }, process.cwd()) ?? "",
				/irreversible deletion/,
				command,
			);
		}
	},
);

test("AST hard-deny checks fail closed on malformed Bash input", () => {
	assert.match(
		deterministicHardDeny("bash", { command: 'echo "unterminated' }, process.cwd()) ?? "",
		/could not be parsed safely/,
	);
});

test("AST hard-deny checks do not execute or inspect quoted command text", () => {
	for (const command of [
		`echo 'git config --global http.sslVerify false'`,
		`printf '%s' 'rm -rf /'`,
		"git push origin main",
	]) {
		assert.equal(
			deterministicHardDeny("bash", { command }, process.cwd()),
			undefined,
			command,
		);
	}
});

test("isRootHomeOrSystemPath exempts home subtree but keeps home root and system paths", () => {
	// Silverblue-style HOME under /var: the case PR #7 fixed. With a real
	// os.homedir() this subtree used to match `path.startsWith("/var/")` and
	// hard-deny routine `rm -rf ~/...`.
	const home = "/var/home/jdoe";
	const cases: Array<[string, boolean]> = [
		[home, true], // rm -rf ~ stays blocked
		[`${home}/projects/foo/build`, false], // the bug: was true before the fix
		["/var", true], // /var itself stays protected
		["/var/log", true], // sibling system path under /var stays protected
		["/var/lib/pkg", true],
		["/etc", true],
		["/usr/share/x", true],
		["/", true],
		["/opt/app", false], // not a tracked system root
	];
	for (const [path, expected] of cases) {
		assert.equal(isRootHomeOrSystemPath(path, home), expected, `path=${path}`);
	}

	// Standard HOME (/home/user): system roots still protected, subtree exempt.
	const stdHome = "/home/jdoe";
	assert.equal(isRootHomeOrSystemPath(stdHome, stdHome), true);
	assert.equal(isRootHomeOrSystemPath(`${stdHome}/src/pkg`, stdHome), false);
	assert.equal(isRootHomeOrSystemPath("/home", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/home/other-user", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/proc/1", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/root/.ssh", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/run/service", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/System/Library", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/Library/LaunchDaemons", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/etc/hosts", stdHome), true);
	assert.equal(isRootHomeOrSystemPath("/opt/app", stdHome), false);
	assert.equal(isRootHomeOrSystemPath("/srv/app", stdHome), false);
});
