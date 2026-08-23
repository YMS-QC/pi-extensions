import type { ToolPattern } from "./types.ts";
import {
  expandHomePattern,
  normalizePathForMatch,
  resolvePathForPolicy,
  resolveToolInputPath,
} from "./paths.ts";

export const MAX_WILDCARD_PATTERN_LENGTH = 4096;
export const MAX_WILDCARD_INPUT_LENGTH = 1024 * 1024;

/** Preserve the previous non-Unicode RegExp `/i` case-equivalence rules. */
function canonicalizeCase(value: string): string {
  let canonical = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const uppercase = character.toUpperCase();
    if (
      uppercase.length !== 1 ||
      (character.charCodeAt(0) >= 128 && uppercase.charCodeAt(0) < 128)
    ) {
      canonical += character;
    } else {
      canonical += uppercase;
    }
  }
  return canonical;
}

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

function literalPrefixTable(value: string): number[] {
  const table = new Array<number>(value.length).fill(0);
  let prefixLength = 0;
  for (let index = 1; index < value.length; index += 1) {
    while (
      prefixLength > 0 && value[index] !== value[prefixLength]
    ) {
      prefixLength = table[prefixLength - 1] ?? 0;
    }
    if (value[index] === value[prefixLength]) prefixLength += 1;
    table[index] = prefixLength;
  }
  return table;
}

function findLiteral(
  value: string,
  literal: string,
  start: number,
  end: number,
): number {
  const prefixTable = literalPrefixTable(literal);
  let matched = 0;
  for (let index = start; index < end; index += 1) {
    while (matched > 0 && value[index] !== literal[matched]) {
      matched = prefixTable[matched - 1] ?? 0;
    }
    if (value[index] === literal[matched]) matched += 1;
    if (matched === literal.length) return index - literal.length + 1;
  }
  return -1;
}

/**
 * Match a case-insensitive `*` wildcard pattern in linear time.
 *
 * `*` matches zero or more characters, including newlines and path separators.
 * Over-limit values match conservatively so deny and ask rules fail closed.
 */
export function matchesWildcardPattern(
  pattern: string,
  value: string,
): boolean {
  if (
    pattern.length > MAX_WILDCARD_PATTERN_LENGTH ||
    value.length > MAX_WILDCARD_INPUT_LENGTH
  ) {
    return true;
  }

  const normalizedPattern = canonicalizeCase(pattern);
  const normalizedValue = canonicalizeCase(value);
  if (!normalizedPattern.includes("*")) {
    return normalizedPattern === normalizedValue;
  }

  const startsWithWildcard = normalizedPattern.startsWith("*");
  const endsWithWildcard = normalizedPattern.endsWith("*");
  const literals = normalizedPattern.split("*").filter(Boolean);
  if (literals.length === 0) return true;

  let literalIndex = 0;
  let valueIndex = 0;
  let lastLiteralIndex = literals.length;

  if (!startsWithWildcard) {
    const prefix = literals[0] ?? "";
    if (!normalizedValue.startsWith(prefix)) return false;
    valueIndex = prefix.length;
    literalIndex = 1;
  }

  let searchEnd = normalizedValue.length;
  if (!endsWithWildcard) {
    const suffix = literals[literals.length - 1] ?? "";
    searchEnd -= suffix.length;
    if (
      searchEnd < valueIndex ||
      !normalizedValue.endsWith(suffix)
    ) {
      return false;
    }
    lastLiteralIndex -= 1;
  }

  for (; literalIndex < lastLiteralIndex; literalIndex += 1) {
    const literal = literals[literalIndex] ?? "";
    const found = findLiteral(
      normalizedValue,
      literal,
      valueIndex,
      searchEnd,
    );
    if (found < 0) return false;
    valueIndex = found + literal.length;
  }

  return true;
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
      matchesWildcardPattern(variant.normalize("NFC"), normalized)
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
    canonicalizeCase(root.replace(/\\/g, "/").normalize("NFC")),
  );
  const prefix = normalizedRoot === "/" || /^[A-Za-z]:\/$/.test(normalizedRoot)
    ? normalizedRoot
    : `${normalizedRoot}/`;
  const normalizedPattern = canonicalizeCase(pattern.normalize("NFC"));
  const wildcardIndex = normalizedPattern.indexOf("*");
  if (wildcardIndex < 0) {
    return normalizedPattern.length > prefix.length &&
      normalizedPattern.startsWith(prefix);
  }

  const fixedPrefix = normalizedPattern.slice(0, wildcardIndex);
  return prefix.startsWith(fixedPrefix) || fixedPrefix.startsWith(prefix);
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
  if (resolvedRoot.length > MAX_WILDCARD_INPUT_LENGTH) {
    return deniedPaths.length > 0;
  }
  return deniedPaths.some((pattern) => {
    if (pattern.length > MAX_WILDCARD_PATTERN_LENGTH) return true;
    return deniedPatternVariants(pattern).some((expanded) =>
      wildcardCanMatchDescendant(resolvedRoot, expanded)
    );
  });
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
  return matchesWildcardPattern(pattern.argumentPattern, primary);
}
