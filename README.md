# pi-automode

Claude Code-style auto mode for Pi.

This is a guardrail extension. It intercepts agent tool calls before execution and blocks actions that match permission deny rules, deterministic hard-deny checks, or the auto-mode classifier's block decision.

It is not a sandbox. Extensions run in the Pi process. A malicious extension can do anything that your user account can do.

Pi-automode does not guard user `!` or `!!` shell commands. It guards only agent tool calls. Use it to reduce unsafe autonomous tool use. Do not use it as an OS security boundary.

## Install

From npm:

```bash
pi install npm:@czottmann/pi-automode
```

From a local checkout:

```bash
pi install .
```

For one run from a local checkout:

```bash
pi -e ./extensions/auto-mode.ts
```

## Commands

```text
/automode status    # current state, rules, and classifier
/automode on        # re-enable for this session
/automode off       # disable for this session
/automode reload    # reload config from disk
/automode reset     # reset denial counters only
/automode defaults  # print the built-in rule lists
/automode config    # effective config, resolved log file path, + diagnostics
/automode denials   # denial history for this session
/automode model     # open classifier model selector and save to ~/.pi/agent/automode.json
/automode model provider/model-id # save classifier model to ~/.pi/agent/automode.json
```

`/auto-mode` is an alias.

## Agent diagnostics

The package registers one model-callable, read-only tool:

`automode_inspect` accepts one `action`:

- `status`: active state and counters
- `config`: active effective configuration, log path, and diagnostics
- `defaults`: built-in rule lists
- `denials`: recent denial timestamps, kinds, and tool names

The tool reads the same in-memory configuration and state that the guardrail enforces. Permission and deterministic checks run before the bypass.

The bypass does not change automode counters, persisted state, or observability logs. The extension verifies the source of the tool before it applies the exemption. Thus, a name collision does not exempt a tool from another extension.

The tool cannot enable or disable auto mode. It cannot reload configuration, reset state, select a model, or change configuration.

Pi sends tool output to the current model. The `status` and `denials` views omit denial reasons and action payloads.

If a diagnosis requires a reason, inspect a known-safe entry in the local observability log. The `config` view includes effective rule text. It removes raw JSON parser details from diagnostics.

Do not put credentials or other secrets in automode rules.

The bundled `automode-diagnostics` skill uses this tool to diagnose unexpected decisions without asking the user to copy output from slash commands. Configuration edits and automode state changes remain user-controlled. See [Agent diagnostics](docs/diagnostics.md) for the inspection contract, privacy limits, and diagnosis workflow.

## Status line

When the Pi TUI is available, the extension renders a persistent status line:

```text
AM● a:12 d:2 ca:5 cd:1
```

- `AM` — auto-mode prefix. `●` means enabled. `○` means disabled through configuration or `/automode off`.
- `a:` — actions allowed so far (checked minus denied).
- `d:` — actions denied so far, for any reason (permission rule, deterministic hard-deny, or classifier).
- `ca:` / `cd:` — classifier decisions split into allowed and denied. These segments appear after the first classifier call. `d:` counts all denials, so `d:` is always `>= cd:`.

## Docs

- [Defaults and rule-list behavior](docs/defaults.md)
- [Auto-mode classifier flow](docs/automode-classifier-flow.md)
- [Observability logging](docs/observability-logging.md)
- [Architecture decisions](docs/adr/INDEX.md)

## Configuration

The extension follows the documented Claude Code configuration model where Pi supports it.

It reads `autoMode` only from Pi-owned configuration sources:

- `~/.pi/agent/automode.json`
- `.pi/automode.local.json` for trusted projects
- `PI_AUTOMODE_SETTINGS_JSON`

It does not read project configuration until Pi trusts the project. For an untrusted project, it ignores `.pi/automode.local.json` and `.pi/automode.json`. `/automode config` reports each ignored file that exists.

Shared project `.pi/automode.json` cannot weaken auto mode. For a trusted project, it can add `permissions.deny` and `permissions.ask` rules.

The shared file cannot set `autoMode` or add `permissions.allow` rules. If the file contains `permissions.allow`, `/automode config` reports a diagnostic.

To disable pi-automode for the current project, create or edit `.pi/automode.local.json`:

```json
{
  "autoMode": {
    "enabled": false
  }
}
```

This file is project-local. Pi reads it only after project trust. Do not commit this file. Shared project `.pi/automode.json` cannot disable auto mode.

Set a global default classifier model in `~/.pi/agent/automode.json`. For a trusted project, override it in `.pi/automode.local.json`.

`classifierReasoningLevel` requests `low`, `medium`, `high`, `xhigh`, or `max` reasoning for both classifier stages. If the key is absent, pi-automode sends no reasoning preference. The server then selects the level.

Pi AI clamps an unsupported value to the nearest level that the selected model supports. A model without reasoning support resolves to `off`. `low` matches the reasoning effort of Codex Auto Review.

Higher levels can use all 512 or 1200 stage tokens before they produce visible output. In this case, the classifier fails closed. If truncation occurs before the required `0` or `1` digit, increase `fastClassifierMaxTokens`. The default is 512, and the minimum is 16.

`classifierTimeoutMs` limits each classifier request in milliseconds. The default is 20000, and the minimum is 1000. The fast and detailed stages have separate budgets.

If a request stalls or exceeds its budget, pi-automode aborts it. Then auto mode fails closed and blocks the action.

`allowInsideWorkingDirectory` adds a deterministic allow tier for the file tools. The default value is `false`. The file tools are `read`, `write`, `edit`, `grep`, `find`, and `ls`.

The value `allowInsideWorkingDirectory: true` allows access to paths inside the working directory without classifier review. Pi-automode sends access to outside paths to the classifier. This rule also applies to read calls.

This tier takes precedence over `classifyReadOnlyTools`. If both configuration fields are enabled, pi-automode still allows in-tree file access locally. `classifyReadOnlyTools: true` does not change this behavior.

Protected in-tree targets do not use this allow tier. Writes and edits to `.git/hooks`, `.pi` controls, shell profiles, and configuration files still reach the classifier.

`deniedPaths` is a list of path glob patterns. The default list is `[]`. A matching pattern blocks a file-tool call before classifier review or an allow tier.

Patterns support `~`, `$HOME`, and `${HOME}` expansion. The `*` wildcard matches all characters, including `/`. Thus, `**/id_rsa` matches a private key at any depth.

Each pattern can contain at most 4,096 UTF-16 code units. Pi-automode matches the typed path and its symlink-resolved form. It also resolves the fixed path prefix of each pattern. Thus, a symlink alias cannot bypass a denied target.

If a recursive `grep` or `find` scope can contain a denied path, pi-automode blocks the call. A broad pattern such as `*.env` blocks these tools for every directory scope.

A matching path blocks the call without classifier review or an override. The list applies only to file tools. The classifier governs `bash` path access. Both keys use the normal scalar and array precedence.

`allowInsideWorkingDirectory` uses scalar precedence: global, then project-local, then `PI_AUTOMODE_SETTINGS_JSON`. `deniedPaths` entries accumulate across these configuration sources.

Shared project `.pi/automode.json` cannot set either field. Omitting either field at a higher-precedence source does not clear a lower-source value.

Example:

```json
{
  "autoMode": {
    "classifierModel": "provider/model-id",
    "classifierReasoningLevel": "low",
    "classifyReadOnlyTools": false,
    "fastClassifierMaxTokens": 512,
    "classifierTimeoutMs": 20000,
    "allowInsideWorkingDirectory": false,
    "deniedPaths": [],
    "maxUserTranscriptTokens": 4000,
    "maxToolTranscriptTokens": 4000,
    "environment": [
      "$defaults",
      "Source control: github.example.com/acme-corp and all repos under it",
      "Trusted internal domains: *.corp.example.com, git.example.com",
      "Trusted cloud buckets: s3://acme-dev-artifacts, gs://acme-ci-cache",
      "Key internal services: staging deploy API at deploy.corp.example.com"
    ],
    "allow": ["$defaults"],
    "protectedPaths": ["$defaults"],
    "soft_deny": ["$defaults"],
    "hard_deny": [
      "$defaults",
      "Never send repository contents to third-party code-review APIs"
    ]
  },
  "permissions": {
    "deny": ["bash(rm -rf *)"],
    "ask": ["bash(git push *)"],
    "allow": ["bash(git status*)", "example-extension-tool"]
  }
}
```

`maxUserTranscriptTokens` and `maxToolTranscriptTokens` are approximate budgets for each category. Both default to 4000 and accept integers of at least 32.

Pi-automode does not support the former `maxTranscriptLines` field. Evidence selection now uses token budgets instead of line counts.

### Ask-user tools and explicit authorization

Classifier evidence includes normal user messages and assistant tool-call inputs. It excludes assistant prose and all tool results. This exclusion includes answers from ask-user tools such as `@vanillagreen/pi-questions`.

Selecting "Yes" in that tool helps the agent select its next action. Pi-automode does not treat the result as authorization to override a soft deny.

Send the authorization as a normal chat message. Then the agent can retry the action. Tool results remain excluded because they can contain untrusted or prompt-injected content.

### `$defaults`

See [Defaults and rule-list behavior](docs/defaults.md) for built-in `environment`, `allow`, `protectedPaths`, `soft_deny`, and `hard_deny` entries. The document also explains replacement behavior after omission of `$defaults`.

### Observability logging

Auto mode can write a JSONL observability log for decisions and classifier usage. Persisted sessions use a sidecar next to the Pi session file. In-memory sessions use a global application directory. Logging is off by default.

```json
{
  "autoMode": {
    "log": {
      "enabled": true,
      "classifierIo": false
    }
  }
}
```

With logging enabled, persisted-session sidecars also contain ccusage-compatible entries for every classifier response. When `classifierIo` is off, `ccusage pi` still reports a separate `-pi-automode` session. In-memory logs use the same entry shape but live outside the normal Pi session tree.

See [Observability logging](docs/observability-logging.md) for the log file location, entry schema, and the `classifierIo` privacy tradeoff. Run `/automode config` to see the resolved log file path.

### Permission patterns

Permission patterns use Pi tool names. Examples include `bash(...)`, `write(...)`, `edit(...)`, and `read(...)`. The parser accepts capitalized names such as `Bash(...)`. The documented form is lowercase because Pi tool names are lowercase.

`permissions.allow` is a deterministic allow tier. The default list is `[]`. A matching rule skips classifier review.

Use this tier for a narrow command such as `bash(git status*)`. You can also use it for a side-effect-free extension or MCP tool.

The matcher understands primary arguments for `bash`, the file tools, and `grep`. For `bash`, it uses `input.command`. For file tools, it uses the resolved `input.path`. For `grep`, it uses `input.pattern`.

For other tools, the matcher uses the serialized input object. Use a bare tool name for an MCP or extension tool. For example, `example-extension-tool` matches every call to that tool.

The providing extension or MCP server defines the Pi tool name. Pi-automode does not need a predefined list.

A match skips only the classifier call. It cannot skip `permissions.deny`, deterministic hard-deny checks, `deniedPaths`, or protected-path controls. An accepted `permissions.ask` rule also takes precedence. After confirmation, the call continues through deterministic checks and then reaches the classifier. It cannot use `permissions.allow`, the inside-working-directory tier, or the read-only fast path.

Pi-automode reads `permissions.allow` only from global configuration, trusted `.pi/automode.local.json`, and `PI_AUTOMODE_SETTINGS_JSON`. Shared `.pi/automode.json` cannot add allow rules.

A pattern can contain at most 4,096 UTF-16 code units. For allow matching, an input can contain at most 1,048,576 UTF-16 code units. A longer input returns no match. Deny and ask patterns match the same oversized input so that they fail closed.

`write` and `edit` calls whose resolved target is a protected path are never covered by `permissions.allow`. This includes protected targets reached through symlink aliases.

## What runs before the classifier

The extension blocks these before any allow or classifier decision:

- `permissions.deny` matches
- declined `permissions.ask` matches
- shell profile writes
- SSH `authorized_keys` writes
- cron, launch agent, and system service persistence
- TLS/certificate/auth weakening patterns
- root, home, and system-path destructive deletes
- edits to `.pi/automode*`, `.pi` auto-mode files, and this extension's safety-control files

After these checks, pi-automode applies `permissions.allow`. Protected `write` and `edit` targets continue to the classifier.

Accepted ask rules also continue to the classifier. They cannot use an allow tier. Pi-automode then allows the read-only tools `read`, `grep`, `find`, and `ls`. Every remaining action goes to the classifier.

A `permissions.allow` rule intentionally skips classifier policy, including classifier `hard_deny` rules. Use narrow patterns and user-owned configuration. Deterministic hard-deny and path controls remain unconditional.

Set `classifyReadOnlyTools: true` (default `false`) to route read-only tools through the classifier. This configuration value increases model calls, latency, and session cost.

Pi-automode blocks a `deniedPaths` match before classifier review or an allow tier. Thus, file tools cannot send matching secret or system paths to the model.

The list does not govern `bash`. The classifier and deterministic hard-deny checks govern shell access to these paths.

The value `allowInsideWorkingDirectory: true` allows file access inside the working directory locally. Pi-automode sends all outside file access to the classifier, including reads.

Classification starts with a conservative one-token filter. If the filter requests review, pi-automode runs structured review.

Both stages receive the complete current tool input in a dedicated message. Transcript truncation cannot remove action content. If the exact input cannot fit in the classifier context, auto mode blocks the call.

Both stages use a classifier-specific session key. They request short cache retention from providers that support it. A missing model, provider failure, or malformed response blocks the action.

## Examples

- `examples/automode.local.json`: copy to `.pi/automode.local.json` in a project and edit the domains, buckets, and source-control org.

## Known limits

Claude Code's real classifier and exact built-in rules are private. This package implements the documented precedence and configuration behavior, with a local classifier prompt and deterministic hard-deny checks.

## Development

```bash
npm run check
npm test
npm pack --dry-run
```

The tests cover these safety-sensitive areas:

- scoped permission matching
- the `permissions.allow` tier and its precedence
- configuration-source precedence and diagnostics
- `$defaults` behavior
- deterministic hard-deny checks and shell parsing
- classifier routing for `write` and `edit`
- symlink-aware safety-control checks
- token-budgeted transcript selection
- staged classifier parsing and cache behavior
- hook-level allow and block behavior

## Publishing

When a maintainer publishes a GitHub Release, GitHub Actions publishes the package to npm. The release tag must match `package.json` exactly. The forms `v1.0.0` and `1.0.0` both match version `1.0.0`.

The workflow uses npm Trusted Publishing, so it does not need an npm token secret. Configure this package on npm with this repository and workflow file (`.github/workflows/publish.yml`). The workflow builds the package, runs `npm run check`, and publishes with npm provenance.

### Release tag must point at the version bump

The publish workflow checks the commit that the release tag identifies. It compares the version in `package.json` with the tag name.

**The tag must identify a commit that contains the new version.**

1. Commit the version change with `chore: release X.Y.Z`.
2. Push `main`.
3. Create the GitHub release from that commit.

If the tag identifies an older version, the `Check release tag` step fails. It reports `Release tag (vX.Y.Z) does not match package.json version (x.y.z)`.

CAUTION: Do not move a correct release tag. Moving the tag changes a published reference.

1. If the tag identifies the wrong commit, force-move it to the version-change commit.
2. Force-push the corrected tag.
3. Run `gh workflow run publish.yml --ref vX.Y.Z`.

When GitHub creates the tag, the `release` event occurs. A rerun of a failed `release` workflow uses the original reference. It does not use the moved tag.

## Author

Carlo Zottmann, <carlo@zottmann.dev>

- Website: https://actions.work
- GitHub: https://github.com/czottmann
- Bluesky: https://bsky.app/profile/zottmann.dev
- Mastodon: https://norden.social/@czottmann
