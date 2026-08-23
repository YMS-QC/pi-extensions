import type { ToolPattern } from "./types.ts";
import {
  expandHomePattern,
  normalizePathForMatch,
  resolvePathForPolicy,
  resolveToolInputPath,
} from "./paths.ts";

function normalizeToolName(name: string): string {
  const lower = name.trim().replace(/^@/, "").toLowerCase();
  const aliases: Record<string, string> = {
    bash: "bash",
    read: "read",
    edit: "edit",
    write: "write",
    grep: "grep",
    find: "find",
    ls: "ls",
  };
  return aliases[lower] ?? lower;
}

/**
 * Parse Pi permission entries such as `bash(git push *)`.
 *
 * Capitalized names such as `Bash(...)` are accepted as a convenience, but Pi's
 * actual tool names are lowercase. Scoped entries stay scoped: we do not flatten
 * `bash(git status *)` into a blanket `bash` permission.
 */
export function parseToolPattern(value: unknown): ToolPattern | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw) return undefined;

  const match = raw.match(/^@?([A-Za-z0-9_-]+)(?:\((.*)\))?$/s);
  if (!match) return { raw };
  return {
    raw,
    toolName: normalizeToolName(match[1] ?? ""),
    argumentPattern: match[2],
  };
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function getPrimaryArgument(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  if (toolName === "bash" && typeof input.command === "string") {
    return input.command;
  }
  if (
    (toolName === "read" || toolName === "write" || toolName === "edit") &&
    typeof input.path === "string"
  ) {
    return normalizePathForMatch(
      resolveToolInputPath(toolName, cwd, input.path) ?? input.path,
      cwd,
    );
  }
  if (toolName === "grep" && typeof input.pattern === "string") {
    return input.pattern;
  }
  if (
    (toolName === "find" || toolName === "ls") &&
    typeof input.path === "string"
  ) {
    return normalizePathForMatch(
      resolveToolInputPath(toolName, cwd, input.path) ?? input.path,
      cwd,
    );
  }
  return JSON.stringify(input);
}

/**
 * Whether a resolved absolute path matches a configured path-denial pattern.
 * Patterns support `~`/`$HOME` expansion and `*` globs, where `*` matches any
 * characters, including `/`. Matching is case-insensitive and
 * conservative-safe: over-matching only blocks more.
 */
export function matchesDeniedPath(
  resolvedPath: string,
  deniedPaths: string[],
): boolean {
  const normalized = resolvedPath.replace(/\\/g, "/").normalize("NFC");
  return deniedPaths.some((pattern) =>
    deniedPatternVariants(pattern).some((variant) =>
      wildcardToRegExp(variant.normalize("NFC")).test(normalized)
    )
  );
}

function deniedPatternVariants(pattern: string): string[] {
  const expanded = expandHomePattern(pattern).replace(/\\/g, "/");
  const wildcardIndex = expanded.indexOf("*");
  if (wildcardIndex === -1) {
    const canonical = resolvePathForPolicy(expanded)?.replace(/\\/g, "/");
    return canonical && canonical !== expanded
      ? [expanded, canonical]
      : [expanded];
  }

  const fixedPrefix = expanded.slice(0, wildcardIndex);
  const lastSlash = fixedPrefix.lastIndexOf("/");
  if (lastSlash < 0) return [expanded];
  const fixedScope = fixedPrefix.slice(0, lastSlash) || "/";
  const canonicalScope = resolvePathForPolicy(fixedScope)?.replace(/\\/g, "/");
  if (!canonicalScope || canonicalScope === fixedScope) return [expanded];
  const suffix = expanded.slice(lastSlash).replace(/^\/+/, "");
  const canonicalPattern = canonicalScope === "/"
    ? `/${suffix}`
    : `${withoutTrailingSlash(canonicalScope)}/${suffix}`;
  return canonicalPattern === expanded
    ? [expanded]
    : [expanded, canonicalPattern];
}

function withoutTrailingSlash(path: string): string {
  if (path === "/" || /^[A-Za-z]:\/$/.test(path)) return path;
  return path.replace(/\/+$/, "");
}

function wildcardCanMatchDescendant(root: string, pattern: string): boolean {
  const normalizedRoot = withoutTrailingSlash(
    root.replace(/\\/g, "/").normalize("NFC").toLowerCase(),
  );
  const prefix = normalizedRoot === "/" || /^[a-z]:\/$/.test(normalizedRoot)
    ? normalizedRoot
    : `${normalizedRoot}/`;
  const normalizedPattern = pattern.normalize("NFC").toLowerCase();

  const addWildcardSkips = (states: Set<number>): Set<number> => {
    const closure = new Set(states);
    const pending = [...states];
    while (pending.length > 0) {
      const state = pending.pop();
      if (state === undefined || normalizedPattern[state] !== "*") continue;
      const next = state + 1;
      if (!closure.has(next)) {
        closure.add(next);
        pending.push(next);
      }
    }
    return closure;
  };

  let states = addWildcardSkips(new Set([0]));
  for (const character of prefix) {
    const nextStates = new Set<number>();
    for (const state of states) {
      const token = normalizedPattern[state];
      if (token === "*") nextStates.add(state);
      else if (token === character) nextStates.add(state + 1);
    }
    states = addWildcardSkips(nextStates);
    if (states.size === 0) return false;
  }

  return [...states].some((state) => state < normalizedPattern.length);
}

/**
 * Whether a recursive search scope can contain a path matched by `deniedPaths`.
 *
 * The check asks whether the wildcard pattern can match any path beginning
 * with the search-root prefix. It does not scan the search tree.
 */
export function recursiveSearchMayReachDeniedPath(
  resolvedRoot: string,
  deniedPaths: string[],
): boolean {
  return deniedPaths.some((pattern) =>
    deniedPatternVariants(pattern).some((expanded) =>
      wildcardCanMatchDescendant(resolvedRoot, expanded)
    )
  );
}

/** Match a scoped permission rule against a concrete tool call. */
export function matchesToolPattern(
  pattern: ToolPattern,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  if (!pattern.toolName) return false;
  if (pattern.toolName !== normalizeToolName(toolName)) return false;
  if (!pattern.argumentPattern || pattern.argumentPattern === "*") return true;
  const primary = getPrimaryArgument(toolName, input, cwd);
  return wildcardToRegExp(pattern.argumentPattern).test(primary);
}
