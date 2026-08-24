import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  analyzeBash,
  type BashAnalysis,
  type BashCommandAnalysis,
  type EffectiveCommand,
} from "./bash.ts";
import { HOME } from "./constants.ts";
import {
  isProfileOrAuthorizedKeysPath,
  isSafetyControlPath,
  resolveInputPath,
  resolvePathForPolicy,
  shellPathTokenToPath,
} from "./paths.ts";

function isRecursiveRmArg(arg: string): boolean {
  return (
    (arg.length > 2 && arg.startsWith("--") && "--recursive".startsWith(arg)) ||
    /^-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*$/i.test(arg) ||
    /^-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*$/i.test(arg)
  );
}

export type RmInvocation = {
  recursive: boolean;
  operands: Array<{ value: string; text: string; tildeExpansion: boolean }>;
};

export function parseRmInvocation(command: EffectiveCommand): RmInvocation {
  let recursive = false;
  let optionsEnded = false;
  const operands: RmInvocation["operands"] = [];

  for (const [index, value] of command.args.entries()) {
    const text = command.argTexts[index] ?? value;
    const tildeExpansion = command.argTildeExpansions[index] ?? false;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value !== "-" && value.startsWith("-")) {
      if (isRecursiveRmArg(value)) recursive = true;
      continue;
    }
    operands.push({ value, text, tildeExpansion });
  }

  return { recursive, operands };
}

function isUnresolvedUserHomeToken(
  shellText: string,
  tildeExpansion: boolean,
): boolean {
  return tildeExpansion && shellText !== "~" && !shellText.startsWith("~/");
}

function isSameExistingPath(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function matchesPathRoot(path: string, root: string): boolean {
  if (path === root || path.startsWith(`${root}/`)) return true;
  const lowerPath = path.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (lowerPath !== lowerRoot && !lowerPath.startsWith(`${lowerRoot}/`)) {
    return false;
  }
  return isSameExistingPath(path.slice(0, root.length), root);
}

/**
 * True for `/`, the user's home root, or a top-level system root such as
 * `/etc`, `/usr`, or `/var`. Excludes the home *subtree*.
 *
 * On some distros (e.g. Fedora Silverblue) HOME lives under `/var`, which is
 * in `systemRoots`. Without the subtree exemption, `path.startsWith("/var/")`
 * would treat every path under HOME as a system root and hard-deny routine
 * `rm -rf ~/...`. HOME itself is still matched below, so `rm -rf ~` stays
 * blocked. `home` is a parameter so this can be unit-tested with a synthetic
 * `/var/home/...` value.
 */
export function isRootHomeOrSystemPath(path: string, home: string): boolean {
  const systemRoots = [
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib64",
    "/Library",
    "/private",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/sys",
    "/System",
    "/usr",
    "/var",
  ];
  if (matchesPathRoot(path, home) && path.length > home.length) return false;
  return (
    path === "/" ||
    matchesPathRoot(path, home) ||
    systemRoots.some((root) => matchesPathRoot(path, root))
  );
}

function segmentHardDeny(
  segment: BashCommandAnalysis,
  cwd: string,
): string | undefined {
  for (const target of segment.redirectTargets) {
    const path = shellPathTokenToPath(target, cwd);
    if (!path) continue;
    const profileReason = isProfileOrAuthorizedKeysPath(path);
    if (profileReason) return profileReason;
    if (isSafetyControlPath(path, cwd)) {
      return "auto-mode or permission safety-control modification is hard-denied";
    }
  }

  for (const word of segment.words) {
    if (
      /^(NODE_TLS_REJECT_UNAUTHORIZED=0|GIT_SSL_NO_VERIFY=(1|true))$/i.test(
        word,
      )
    ) {
      return "TLS verification weakening is hard-denied";
    }
  }

  const command = segment.effectiveCommand;
  const name = command.name;
  if (!name) return undefined;
  const args = command.args;
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (
    ["curl", "wget"].includes(name) &&
    lowerArgs.some((arg) =>
      ["--insecure", "-k", "--no-check-certificate"].includes(arg)
    )
  ) {
    return "certificate verification weakening is hard-denied";
  }
  if (
    ["npm", "yarn", "pnpm"].includes(name) &&
    lowerArgs[0] === "config" &&
    lowerArgs[1] === "set" &&
    ["strict-ssl", "cafile"].includes(lowerArgs[2] ?? "") &&
    ["false", "null"].includes(lowerArgs[3] ?? "")
  ) {
    return "package-manager TLS weakening is hard-denied";
  }
  if (
    name === "git" &&
    lowerArgs[0] === "config" &&
    lowerArgs.some(
      (arg) => arg === "sslverify" || arg.endsWith(".sslverify"),
    ) &&
    lowerArgs.includes("false")
  ) {
    return "git TLS verification weakening is hard-denied";
  }
  if (name === "crontab" && !lowerArgs.includes("-l")) {
    return "persistence or system service mutation is hard-denied";
  }
  if (
    name === "launchctl" &&
    ["load", "bootstrap", "enable"].includes(lowerArgs[0] ?? "")
  ) {
    return "persistence or system service mutation is hard-denied";
  }
  if (
    name === "systemctl" &&
    ["enable", "disable"].includes(lowerArgs[0] ?? "")
  ) {
    return "persistence or system service mutation is hard-denied";
  }
  if (name === "security" && lowerArgs[0] === "add-trusted-cert") {
    return "platform security weakening is hard-denied";
  }
  if (name === "spctl" && lowerArgs.includes("--master-disable")) {
    return "platform security weakening is hard-denied";
  }
  if (name === "csrutil" && lowerArgs[0] === "disable") {
    return "platform security weakening is hard-denied";
  }

  if (name === "rm") {
    const rm = parseRmInvocation(command);
    if (rm.recursive) {
      for (const { value: arg, text: shellText, tildeExpansion } of rm.operands) {
        if (isUnresolvedUserHomeToken(shellText, tildeExpansion)) {
          return "irreversible deletion of a user-home expansion is hard-denied";
        }
        const path = shellPathTokenToPath(arg, cwd, shellText);
        const policyPath = path ? (resolvePathForPolicy(path) ?? path) : undefined;
        const policyHome = resolvePathForPolicy(HOME) ?? HOME;
        if (policyPath && isRootHomeOrSystemPath(policyPath, policyHome)) {
          return "irreversible deletion of home/root/system paths is hard-denied";
        }
      }
    }
  }

  if (name === "find" && lowerArgs.includes("-delete")) {
    const root = shellPathTokenToPath(args[0] ?? "", cwd);
    const policyRoot = root ? (resolvePathForPolicy(root) ?? root) : undefined;
    const policyHome = resolvePathForPolicy(HOME) ?? HOME;
    if (
      policyRoot &&
      isRootHomeOrSystemPath(policyRoot, policyHome) &&
      policyRoot !== policyHome
    ) {
      return "system-wide delete is hard-denied";
    }
  }

  if (["chmod", "chown"].includes(name)) {
    for (const arg of args.filter((arg) => !arg.startsWith("-"))) {
      const path = shellPathTokenToPath(arg, cwd);
      if (
        path &&
        (path.startsWith("/etc/") ||
          path.startsWith("/usr/") ||
          path.startsWith("/bin/") ||
          path.startsWith("/sbin/") ||
          path.startsWith("/System/") ||
          path.startsWith(resolve(HOME, ".ssh")))
      ) {
        return "system or SSH permission mutation is hard-denied";
      }
    }
  }

  if (
    [
      "tee",
      "mv",
      "cp",
      "rm",
      "unlink",
      "truncate",
      "python",
      "python3",
      "node",
      "perl",
      "ruby",
      "sd",
      "sed",
    ].includes(name) &&
    /\.pi\/automode|\.pi\/extensions|pi-automode|auto-mode\.json/i.test(
      segment.raw,
    )
  ) {
    return "auto-mode or permission safety-control modification is hard-denied";
  }

  return undefined;
}

/**
 * Deterministic deny checks for actions too risky to delegate to the classifier.
 *
 * Bash checks use the shared unbash AST analysis. The hook passes one analysis
 * through every enforcement stage so nested commands are not reparsed.
 */
export function deterministicHardDeny(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  bashAnalysis?: BashAnalysis,
): string | undefined {
  if (toolName === "write" || toolName === "edit") {
    const path = resolveInputPath(cwd, input.path);
    if (!path) return undefined;
    const policyPath = resolvePathForPolicy(path) ?? path;
    const policyCwd = resolvePathForPolicy(cwd) ?? cwd;
    const profileReason = isProfileOrAuthorizedKeysPath(policyPath);
    if (profileReason) return profileReason;
    if (isSafetyControlPath(policyPath, policyCwd)) {
      return "auto-mode or permission safety-control modification is hard-denied";
    }
  }

  if (toolName !== "bash") return undefined;
  const command = typeof input.command === "string" ? input.command : "";
  const analysis = bashAnalysis ?? analyzeBash(command);
  if (analysis.errors.length > 0) {
    return `Bash input could not be parsed safely: ${analysis.errors[0]?.message ?? "unknown parser error"}`;
  }
  for (const target of analysis.redirectTargets) {
    const path = shellPathTokenToPath(target, cwd);
    if (!path) continue;
    const profileReason = isProfileOrAuthorizedKeysPath(path);
    if (profileReason) return profileReason;
    if (isSafetyControlPath(path, cwd)) {
      return "auto-mode or permission safety-control modification is hard-denied";
    }
  }
  for (const segment of analysis.commands) {
    const reason = segmentHardDeny(segment, cwd);
    if (reason) return reason;
  }
  return undefined;
}
