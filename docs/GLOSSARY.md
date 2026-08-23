# Glossary

Canonical vocabulary for `@czottmann/pi-automode`. Project-specific terms only — standard technical words appear here only when this project uses them in a specific way. Longer explanations live in the docs linked from each entry.

## Enforcement flow

The ordered pipeline that runs on every agent tool call before execution. See [Auto-mode classifier flow](automode-classifier-flow.md).

**Auto mode** — Claude Code-style guardrail posture: a pre-execution classifier allows routine, reversible actions and blocks risky ones, replacing routine permission prompts.

**Deterministic hard-deny** — Local code checks that block high-risk actions before any classifier call and cannot be overridden. Distinct from the config-level [hard_deny](#classifier-policy-and-rules); independent of the model.

**`permissions.allow` tier** — User-owned list of scoped tool patterns whose matches skip classifier review after deterministic checks pass. An accepted `permissions.ask` rule disables this tier for the current call. The tier cannot override a deny or cover protected `write` and `edit` targets. See [ADR-001](adr/ADR-001-permission-precedence-and-trust-boundaries.md).

**Read-only bypass** — The default fast path where the read-only tools (`read`, `grep`, `find`, `ls`) are allowed without classifier review once permission and deterministic checks pass. `classifyReadOnlyTools` routes them through the classifier instead.

**Staged classifier** — The two-stage safety classifier: a conservative one-token filter gates an optional structured review. See [Fast stage](#enforcement-flow) and [Detailed stage](#enforcement-flow).

**Fast stage** — The first classifier stage: a one-token filter that returns `0` (clearly allowed) or `1` (may need review).

**Detailed stage** — The second classifier stage, run when the fast stage requests review, that returns a structured allow/block decision.

## Classifier policy and rules

The classifier's deny tiers and rule-list syntax. See [Defaults and rule-list behavior](defaults.md).

**hard_deny** — Unconditional classifier rules that cannot be overridden. Distinct from the code-level [deterministic hard-deny](#enforcement-flow) checks.

**soft_deny** — Overridable classifier block rules, unlike [hard_deny](#classifier-policy-and-rules).

**explicit_intent** — A classifier tier meaning the allow was justified because the user's latest instruction directly and specifically authorized an otherwise [soft-denied](#classifier-policy-and-rules) action.

**allow exception** (`autoMode.allow`) — Prose rules that let the classifier allow an action a [soft_deny](#classifier-policy-and-rules) rule would otherwise block. They never override [hard_deny](#classifier-policy-and-rules) and are unrelated to the [`permissions.allow` tier](#enforcement-flow).

**`$defaults`** — A section-local marker in a rule list that expands to the built-in entries for that list.

## Status

**AM status line** — The persistent TUI footer (prefixed `AM`) that reports auto-mode status: enabled/disabled and action/classifier counts.
