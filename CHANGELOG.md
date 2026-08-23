# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## New features

- **Configurable classifier request timeout** — new `autoMode.classifierTimeoutMs` setting. The default is 20000 ms. The timeout applies to each classifier request. The fast stage and the detailed stage each have their own budget. A request that exceeds the timeout is aborted. Auto mode fails closed and blocks the action.
- **Read-only agent diagnostics** — Add `automode_inspect` tool for status, configuration, defaults, and recent denial metadata. Thank you, @blalor! (#11)

## Bug fixes

- **Runtime classifier providers** — Dispatch classifier calls through Pi's runtime model registry so providers registered with `pi.registerProvider()` work immediately. Preserve normalized reasoning and header-only authentication on the temporary simple-completion bridge. (#15)
- **Bounded wildcard matching** — Replace regex-based permission and denied-path globs with a linear-time matcher. Reject oversized patterns and fail closed for oversized runtime inputs. (#19)
- **Complete classifier action input** — Send the exact current tool input to both classifier stages in a dedicated message. Block the action if it cannot fit without truncation. (#17)
- **Path policy normalization** — Use Pi-compatible resolution for file-tool paths, including file URLs, `@` and tilde aliases, and read fallback names. Enforce denied paths across omitted and recursive search scopes and both sides of symlink aliases. (#18)
- **Project config trust gate** — Ignore `.pi/automode.local.json` and `.pi/automode.json` until Pi trusts the project. Apply the trust gate during startup and config reloads. (#16)
- **In-memory observability logs** — Write logs to an extension-owned directory (`~/.pi/agent/extensions/pi-automode/logs/`) instead of the launching project directory. Thanks, @HerbertGao! (#13)
