# Observability logging

Auto mode can write a JSONL decision log next to the current Pi session file, so you can see what it allowed or blocked, and how. It is off by default and fail-open: a write error never changes an allow/block decision.

## Enabling

Set `autoMode.log` in any Pi-owned config source (`~/.pi/agent/automode.json`, `.pi/automode.local.json`, or `PI_AUTOMODE_SETTINGS_JSON`):

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

- `enabled` — write one `decision` line per tool-call decision.
- `classifierIo` — also write the classifier's prompt, raw model responses, and parsed decision for classifier-routed actions. Off by default; see [Privacy](#privacy) below.

Fields merge independently across config scopes (set `enabled` globally and `classifierIo` per project, for example). Shared project `.pi/automode.json` cannot set `log` — it follows the same `autoMode` exclusion as the rest of the config. Shape is validated and reported by `/automode config`.

Logging only writes entries while auto-mode is **enabled**. With auto-mode off, no tool calls reach the hook, so no entries are produced.

## Log file location

The log file is colocated with the current Pi session file, with `-pi-automode` inserted before the extension:

```text
<session-file>                       →  <dir>/<id>.jsonl
<session-file>-pi-automode.jsonl     →  <dir>/<id>-pi-automode.jsonl
```

For example: `~/.pi/agent/sessions/<slug>/<id>-pi-automode.jsonl`. If no session file is set, it falls back to `<sessionDir>/<sessionId>-pi-automode.jsonl`. Run `/automode config` to see the resolved path.

There is one combined file per session. Each line is one JSON object with a `type` discriminator. Entries for the same tool call share a `decisionId`.

## Entry types

### `decision`

One per tool-call decision. Every allow and every block goes through exactly one of these.

| field | meaning |
| --- | --- |
| `ts` | ISO timestamp |
| `decisionId` | links to the `classifier` entry (if any) for the same call |
| `sessionId` | Pi session id |
| `cwd` | working directory |
| `tool` | tool name, e.g. `bash`, `write` |
| `summary` | `actionSummary` — tool name + input JSON (truncated) |
| `kind` | enforcement path: `permissions.deny`, `permissions.ask`, `deterministic-hard-deny`, `classifier`, or `read-only` |
| `outcome` | `allow` or `block` |
| `reason` | the reason string (classifier reason, or the deterministic/permission reason) |
| `classifierModel` | the configured classifier model, when relevant |

### `classifier`

Written only for classifier-routed actions, and only when `classifierIo: true`. It precedes the matching `decision` line in the file.

| field | meaning |
| --- | --- |
| `ts` | ISO timestamp |
| `decisionId` | matches the `decision` entry for the same call |
| `model` | classifier model used, e.g. `anthropic/claude-haiku-4` |
| `prompt.system` | the full system prompt with `environment`/`allow`/`soft_deny`/`hard_deny` rules interpolated |
| `prompt.user` | the full user message: loaded project instructions + transcript + action |
| `attempts` | one entry per classifier attempt (see below) |
| `durationMs` | total classifier time |
| `parsed` | the final decision that was acted on (`{ decision, tier, reason }`) |

Each `attempts[]` entry is `{ attempt, response?, parsed?, error?, durationMs }`:

- `response` — `{ stopReason, text }`, the raw model output for that attempt.
- `parsed` — the decision parsed from the response, or absent if it did not parse.
- `error` — present when the call threw (network/auth); `response` is then absent.

This records retries and fail-closed cases verbatim: a call that returned garbage, retried, then succeeded shows two attempts with the first `parsed` absent.

## Privacy

`prompt.user` is **exactly what is sent to the classifier model** — loaded project instructions, the recent transcript, and the action being classified. See [Auto-mode classifier flow → What is sent to the classifier](automode-classifier-flow.md#what-is-sent-to-the-classifier) for how that message is assembled and truncated.

The log records this payload locally, but the same data is also sent to the classifier model endpoint on every classifier-routed call. If `classifierModel` points at a cloud provider, that payload leaves the machine. Enable `classifierIo` when debugging classifier behavior or tuning rules; leave it off for routine outcome logging.

## Sizing

- `decision` line: ~0.4–2 KB (driven by `summary`, which carries the tool input, capped at 6 KB).
- `classifier` line: ~5 KB fixed (the system prompt) plus the transcript, which is variable. In a long session the transcript dominates — roughly 30–40 KB per classifier-routed action.

The transcript is bounded by `autoMode.maxTranscriptLines` (default 80). Lowering it shrinks both the `classifier` log line and what the classifier receives, at the cost of less context for the classifier's decision.
