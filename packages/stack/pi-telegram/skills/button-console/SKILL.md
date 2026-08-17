---
name: button-console
description: Turns terminal programs, filesystem navigation, system inspection, and operator workflows into contextual agent-generated button interfaces while preserving full or faithfully adapted console output. Use when a user asks for controls, menus, navigation, actions, or an operating-system/CLI interface through Telegram or another prompt-button transport.
---

# Button Console

Build a temporary, truthful button interface over terminal and operating-system capabilities. The agent remains the interpreter and safety boundary; buttons are contextual prompts, not a second shell, static application, or hidden automation daemon.

## Concept

```text
User intent → narrow inspection/action → console evidence → readable output → contextual buttons → next user intent
```

Each response is one generated screen. Reinspect current reality and regenerate controls after every action rather than maintaining a parallel navigation model.

## Core Contract

- Inspect reality before rendering entries or controls that depend on current state.
- Use normal console programs as capability owners.
- Show complete output when reasonably sized; otherwise adapt it without changing material facts and offer pagination, filtering, raw output, or drill-down.
- Make every button prompt self-contained: name the exact target, operation, output expectation, and safety restriction.
- Treat button clicks as ordinary user requests subject to the same authority and validation rules as typed requests.
- Never infer permission for destructive, privileged, credential-bearing, external, or irreversible work merely because a button exists.
- Do not read secrets to populate navigation. Names and safe metadata may be listed; contents require justified, explicit authorization.
- Never place credentials, private keys, tokens, cookies, wallet material, or sensitive file contents in labels or prompts.

## Screen Model

A screen normally contains:

1. A short title naming the current target.
2. Console output or a faithful adaptation.
3. Optional provenance such as path, command class, timestamp, exit status, or truncation note.
4. Buttons for likely next actions.
5. `Back` or `Up` for hierarchy navigation.
6. `Refresh` when state may change.

Prefer 4–12 useful buttons. Split larger sets into categories or pages rather than creating a dense button wall.

## Console Fidelity

Complete output preserves ordering, names, identifiers, numeric values, units, warnings, errors, and relevant exit status. Use a code block only when formatting is semantically meaningful; use compact records for simple listings.

Adaptation may:

- Replace columns with labeled records.
- Normalize human-readable sizes.
- Group entries by type.
- Collapse repeated successful lines.
- Show a bounded head, tail, page, or ranked subset.
- Translate labels into the user's language.

Adaptation must not:

- Convert failure into success.
- Omit material warnings.
- Change identities, values, or ordering claims.
- Present a filtered subset as complete.
- Hide truncation, filtering, or an unavailable measurement.

State adaptation explicitly, for example: `Показаны 20 из 184 записей, по размеру`.

## Filesystem Navigation

- Resolve the requested path before listing it.
- List directories without reading file contents.
- Include every ordinary entry unless the user requested a filter.
- Do not silently omit a sensitive-looking entry; show its name when listing is safe, then handle its contents conservatively.
- Hidden directories default to names and metadata only.
- Use absolute or otherwise unambiguous paths in button prompts.
- Keep `Up`, `Home`, and `Refresh` where useful.
- Offer safe file operations first: metadata, non-sensitive preview, attach/send, or open with an appropriate application.

Never expose credential-file contents through a preview button. This includes `*.keys`, private SSH keys, credential stores, browser profiles, cookies, tokens, and wallets.

## System And Process Controls

Read-only controls may directly request system status, uptime, load, memory, temperatures, disk use, process ranking, service state, network state, application discovery, and bounded redacted logs.

Use a two-stage flow for high-impact actions:

1. An action button opens a confirmation screen naming the exact target and consequences.
2. A distinct confirmation button requests the exact operation.

This applies to shutdown, reboot, process termination, package removal, file deletion, permission changes, service mutation, disk operations, and similar work. Use danger styling when available. Re-check the target immediately before execution and report resulting console evidence.

## Button Generation

When the transport supports prompt buttons, emit its canonical button action syntax. For pi-telegram this is a top-level hidden `telegram_button` comment:

```html
<!-- telegram_button: {"label":"📂 Downloads","prompt":"Show the current contents of /home/user/Downloads without reading file contents, then provide contextual navigation buttons."} -->
```

Button prompts must:

- Use an exact target where possible.
- Describe one coherent intent.
- Preserve the user's language.
- State important exclusions such as not reading secrets.
- Request fresh state after mutations.
- Avoid embedding volatile output that should be reinspected.

Labels stay short, distinct, and scannable. Emoji are optional semantic markers; do not rely on color alone. If buttons are unavailable, render the same interface as a numbered choice list.

## Action Procedure

1. Identify the current target and capability.
2. Classify the action as read-only, ordinary mutation, privileged, destructive, secret-bearing, or external.
3. Run the narrowest console inspection needed for a truthful screen.
4. Check exit status and stderr; never build a success menu from failed evidence.
5. Render complete or explicitly adapted output.
6. Generate only context-relevant next-action buttons.
7. On the next turn, reinspect when freshness matters and execute only the newly authorized action.
8. Report outcome evidence and regenerate the screen from retained reality.

## Failure And Empty States

- On command failure, show the concise error and offer diagnosis, retry, Back, or a narrower action.
- For an empty directory, say so and retain Up, Home, and Refresh.
- If a target disappeared, return to its nearest valid parent rather than reusing stale evidence.
- On access denial, do not escalate privileges automatically.
- If output may contain secrets, stop before display and offer metadata-only or redacted alternatives.
- Mark unsupported, sentinel, or obviously invalid sensor values as unreliable instead of reporting them as facts.

## Quality Check

Before sending a screen, verify:

- Displayed state comes from current console evidence.
- Complete versus filtered output is labeled honestly.
- No ordinary entry was accidentally omitted.
- No secret appears in text or button payloads.
- Every button has a valid self-contained next intent.
- Destructive actions lead to confirmation rather than immediate execution.
- Back/Up and Refresh exist when materially useful.
- The response remains readable on a mobile screen.
