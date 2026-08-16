# Pi TUI Kit Roadmap

- **Status:** Complete through published API 12 and its proof migrations.
- **Audience:** Pi TUI Kit maintainers and extension authors.
- **Planning horizon:** Current maintained Pi and extension behavior.
- **Repository source:** `@narumitw/pi-tui-kit` owns reusable cross-mode interaction, lifecycle, rendering-safety, and testing contracts only where proof migrations demonstrated compatible consumers.
- **Evidence:** Maintained package and consumer tests, registry/package verification, root gates, and PRs #478, #520, #741 through #749.

## Vision

`@narumitw/pi-tui-kit` gives Pi extensions a small dependable set of declarative interaction patterns that feel native to Pi without depending on Pi private UI implementation.

Extensions keep domain state, persistence, safety, and product language while the Kit owns proven shared presentation, navigation, cancellation, disposal, stale-session handling, and display safety.

## Current State

The maintained package exposes eight declarative screen kinds: `actions`, `detail`, `browse`, `choice`, `settings`, `input`, `review`, and `multiSelect`.

Published API 12 also exposes `runTask()`, `runConfirmation()`, `runLiveChoice()`, `formatInteractionHints()`, `runCustomInteraction()`, `sanitizeTerminalText()`, optional searchable `choice`, and the supported `/testing` subpath.

The roadmap has no active implementation phase left.

Future changes should start from a focused plan only when new evidence shows a compatible reusable contract or a public Pi API can replace an existing Kit contract.

## Completed Capabilities

- Menu sessions preserve distinct Back, Close, Stale, Unsupported, and Error outcomes where the host can observe them.
- Bounded review adapts to terminal height while fixed-size and RPC behavior stay compatible.
- The supported testing subpath drives real TUI and RPC adapters without exposing private component instances.
- The internal interaction driver owns shared semantic action coordination while adapters retain presentation cadence.
- Browse owns read-only searchable list/detail presentation without owning catalog freshness, status, or domain actions.
- `runCustomInteraction()` owns reusable cancellation, disposal, stale-owner classification, and pending-work draining around extension-owned components.
- `runConfirmation()` preserves explicit Confirmed, Back, Close, Stale, Unsupported, and Error outcomes without owning side effects.
- Disabled action rows show sanitized unavailable reasons while remaining inert and raw-identity safe.
- Deferred multi-select transaction ownership remains extension-owned after Sync and Subagents failed the shared Save/Discard and persistence contract gate.
- `runLiveChoice()` owns bounded cursor selection and lifecycle mechanics while consumers retain preview snapshots, rollback, persistence, and final apply policy.
- Exact browse documents preserve whitespace-sensitive text, code, and diff detail without making document bodies implicit search metadata.
- Confirmation-only live-choice gating keeps safe shortcuts available while full disabled state still blocks every action.
- Existing custom lifecycle convergence moved Starship and File Context duplicate lifecycle wrappers onto published Kit contracts while specialized behavior stayed local.
- `sanitizeTerminalText()` centralizes one display-only terminal-control policy proven by Statusline and Starship without absorbing redaction, truncation, path, URL, hyperlink, or logging policy.
- Searchable single choice adds opt-in TUI search over labels, descriptions, and explicit `searchText` while RPC remains deterministic and raw item IDs remain consumer-owned.

## Proof Migrations

- Usage, Stamp, and Image Drop proved early task, input, review, and confirmation boundaries.
- Starship Modules proved read-only browse.
- Sync proved custom-interaction lifecycle ownership without moving Sync transaction policy into the Kit.
- Statusline and Starship proved bounded live choice.
- Tool proved exact browse documents.
- Starship and File Context proved existing custom lifecycle convergence.
- Statusline and Starship proved terminal display sanitization.
- BTW Resume and Worktree identity selection proved searchable single choice.

## Retained Boundaries

- Extensions own domain drafts, validation, authorization, persistence, rollback, wording, settings, and session ownership.
- Raw model IDs, paths, URLs, action IDs, settings, persisted values, and domain payloads never round-trip through display sanitizers.
- Multi-line editors remain extension-owned while Pi lacks an abort-aware cross-mode editor contract.
- Transactional multi-select remains extension-owned unless consumers converge on Save/Discard cadence, review, persistence, conflict recovery, and interactive RPC semantics.
- Action-bearing catalogs, async catalogs, trees, transcript workflows, reorder flows, setup/auth flows, preview-state frameworks, and session selectors remain specialized until two compatible consumers prove otherwise.
- Image Drop's loader remains local because it distinguishes Escape Back from Ctrl+C Close while `runTask()` exposes one user-cancelled outcome.
- Direct dialog count is not an admission criterion.
- Public Pi controls should replace Kit contracts only when they provide the complete cross-mode lifecycle contract.

## Future Admission Rules

- Require two compatible consumers before adding a public screen or lifecycle API by default.
- Record an explicit no-go or deferral when evidence does not converge.
- Publish Kit APIs independently and verify the registry package before any consumer raises its compatibility floor.
- Keep one lifecycle or capability contract per PR.
- Preserve consumer capability during migrations, including preview, rollback, selection restoration, three-way cancellation, persistence, validation, failure recovery, and non-TUI behavior.
- Keep production imports from Pi private `dist/*` paths at zero.
- Maintain deterministic TUI/RPC coverage for success, rejection, cancellation, disposal, owner abort, stale state, callback failure, session replacement, and shutdown.
- Run package checks, root `npm run check`, deterministic runtime smokes where practical, and package dry-runs for public package changes.

## Reassessment Triggers

- A Pi dependency upgrade exposes a stable public cross-mode lifecycle contract that matches a Kit screen.
- Two maintained consumers independently need the same specialized interaction without incompatible domain ownership.
- A Kit contract starts hiding a consumer capability or forcing domain state into shared code.
- Terminal rendering, width, or input safety assumptions change in Pi TUI.
- Registry verification or consumer floor sequencing cannot prove that an API is independently published.

## Decisions and Changes

| Date | Decision or change | Rationale and impact |
| --- | --- | --- |
| 2026-07-30 | Require compatible consumer evidence before adding shared screens. | This prevents one-off APIs and unsupported abstraction growth. |
| 2026-08-01 | Publish distinct menu termination reasons, adaptive review, and the supported testing subpath. | These contracts removed proven lifecycle and test-host duplication while keeping domain completion values local. |
| 2026-08-02 | Publish read-only browse, injected hints, and custom-interaction lifecycle ownership. | Catalog presentation and specialized-component lifecycle became reusable while data freshness and side effects stayed consumer-owned. |
| 2026-08-08 | Publish confirmation, disabled action presentation, and the deferred multi-select no-go. | Rich cancellation and unavailable-action semantics converged, but transaction ownership did not. |
| 2026-08-08 | Complete direct-dialog and Pi public-export review without admitting or retiring another API. | Call volume alone did not justify wrappers, and Pi public controls remained lower-level than Kit cross-mode contracts. |
| 2026-08-10 | Publish bounded live choice, exact browse documents, and confirmation-only live-choice gating. | Cursor-selection lifecycle, exact disclosure, and safe shortcut gating became reusable while preview and final apply policy stayed local. |
| 2026-08-13 | Complete existing-contract convergence through Starship and File Context. | Published lifecycle and testing contracts removed duplicate wrappers while specialized UI stayed local. |
| 2026-08-13 | Publish API 12 with terminal display sanitization and searchable choice. | Statusline, Starship, BTW, and Worktree proof migrations later confirmed the two contracts in separate consumers. |
| 2026-08-14 | Complete proof migrations for Statusline, Starship, BTW, and Worktree. | PRs #746 through #749 preserved raw identity and domain ownership while proving terminal safety and searchable choice. |
