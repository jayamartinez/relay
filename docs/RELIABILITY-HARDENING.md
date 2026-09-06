# Reliability and scale hardening — 2026-09-06

This extends existing PR #4 on `fix/session-restore-reconciliation`, based on `feat/relay-v1`. The restore settling, local collapsed-state, popup approval, rejection-safe queue, and remote-generation fixes already on the branch were retained. Manual testing is pending. No server, wire-format, cryptographic implementation, account, pairing, or recovery format changed.

## Findings and results

1. **Reliability weaknesses.** Found transport errors misclassified as fatal; delayed socket handler installation; backoff reset on unstable opens; missing watchdog coverage during first connection; recovery that could flush without completing interrupted hydration; consumed event evidence lost on browser-query failure; new duplicate URLs stealing an existing physical tab's logical ID; tied canonical order keys applied as literal physical positions; stale delete identity checks; redundant storage/group work; and browser tasks repeatedly rescheduling while halted/loading. Each has a focused fix/test.

2. **Disconnect root causes.** Reproducible code paths, not attribution from unavailable production incident logs: a stream abort after HTTP headers became a generic fatal parse error; an HTML outage response became fatal rather than retaining its 408/429/5xx classification; an open/close event could arrive during the awaited persistence preceding handler attachment; a suspended first connection had no guaranteed alarm; expired challenges after laptop sleep became fatal; and an interrupted startup with an open socket could remain outside LIVE. The existing serial queue itself was already rejection-safe.

3. **WebSocket changes.** Handler attachment precedes storage; every callback checks current socket ownership; retired handlers are removed. Error and heartbeat-send failure recover without relying on a close callback. Jittered exponential retry is capped at 30 seconds, with one pending timer and reset after 60 seconds of traffic. Healthy CONNECTING sockets are retained. The existing 20-second connect and 75-second stale thresholds remain. The existing 25-second ping/automatic pong remains compatible with Durable Object hibernation; no additional polling/heartbeat was added.

4. **Worker wake changes.** Install the alarm before authentication or socket opening. Worker startup still loads encrypted identity/mapping/journal and hydrates before live processing. Interrupted storage loading retries the entire load without creating a new identity. Browser events, runtime messages/popups, socket work and alarms retain the common load/serialized-controller entry. Reconnect completes interrupted hydration even if an old socket is open.

5. **Queue robustness.** Retained the tested rejection-safe queue and added pending-task diagnostics. Browser work coalesces while one task is queued. Failure reporting cannot poison later tasks. Halted/loading states stop immediate browser rescheduling. Failed browser capture restores close/navigation evidence before the next safe task.

6. **Notifications.** Retained receive-time remote-generation tracking and acknowledge-only-the-requested-generation semantics. Browser processing drains remote dirty state at a safe point; acknowledged queued hints do not trigger repeated pulls. Backoff retains hints rather than retrying for each queued callback. The real transport test holds a sync response, changes the peer before socket reopening, and verifies that the later revision arrives automatically.

7. **Session restore.** Kept topology/event-based settling and adoption before canonical mutation. Startup no longer clears events received during awaited mutations/persistence. Native Chromium restoration passed with 200 tabs, five windows, twenty groups, duplicates and local collapsed groups, followed by a synced navigation. Persistent intent is replaced from the latest projected revision on reload. At the destructive boundary, each deletion checks a fresh physical tab identity and the close guard.

8. **Large-session bottlenecks.** Restore repeatedly classified/sorted/scanned tabs, and group matching repeatedly sorted member sets. Group reconciliation persisted its partially rebuilt mapping for every group, even if unchanged. Already-current reconciliation still queried individual tabs. Indexed matching and no-op paths reduce this work while keeping immediate persistence for journal/intent/returned IDs.

9. **Quadratic paths.** Removed per-tab canonical searches during restore and observation, per-navigation reverse-ID searches, repeated close-authorization scans, and per-group sorting/scanning of all candidate member sets. Remaining slow paths include window-candidate scoring, group membership repair, per-resource browser reads during actual mutations, and repeated workspace projection for long offline queues. These are documented limits, not claims of fully linear reconciliation.

10. **Browser mutations.** Existing same-URL/pin/group checks remain. A complete current-state check avoids unnecessary per-resource reconciliation. Physical tab IDs are reserved before duplicate matching. Contiguous local ordering prevents impossible repeated move attempts when canonical order keys tie. Metadata/current group checks avoid regrouping or touching collapsed state.

11. **Storage writes.** Identical durable state skips encryption and IndexedDB writes; failed saves never update that cache. Save input is snapshotted before asynchronous encryption. Group mapping saves occur when native bindings change. In the 200-tab synthetic run, persistence callback boundaries fell from approximately 36,271 to 1,415 during the pass. These are callback counts, not measured disk writes; runtime `storageWrites` counts completed actual state saves. A dedicated test verifies identical writes are skipped and failed writes retried.

12. **Request chatter.** Already-acknowledged change hints skip redundant sync requests, and browser events during disconnected backoff still journal locally without retrying the server for every event. Challenge/action authentication and verified canonical acknowledgment remain intact. No checkpoint/journal acknowledgment was weakened. Runtime `serverRequests` counts actual fetch invocations. Model stress reports accepted batches, not real HTTP counts.

13. **Groups.** Exact logical member-set indexing retains ambiguity checks and supports changed native group IDs. Collapsed state stays device-local. Current groups skip repair; rebound IDs remain durable before metadata calls. Group work checks the shutdown guard between mutations. Real Chromium exercised twenty groups; synthetic 200-tab restoration exercised sixty-five.

14. **Error classification.** Known missing tab/window/group and edit-lock races are transient. Fetch/body transport failures, 408/429/5xx, storage transaction AbortError and expired challenges recover. Expired authentication is discarded and re-authenticated, never accepted. Other challenge validation, signature/decryption/control-chain/schema failures, missing durable keys and unknown errors still fail closed. 404/409/410 remain action-required; the existing push/checkpoint conflict handling remains.

15. **Needs attention.** Body interruptions, outage HTML, missing groups, aborted storage and challenge expiry no longer take the fatal path. Explicit user navigation releases old remote reversal expectations. Actual integrity/key/schema errors and unknown exceptions still require inspection. Unsupported group capability remains fail-closed. Offline queue exhaustion remains an intentional integrity-preserving halt requiring attention; navigation circuit pauses remain visible and require inspection/resume. A revoked device is wiped through the existing verified membership path. No blanket conversion of unknown errors to retry was introduced.

16. **20-tab stress.** PASS: two simulated devices, 300 synthetic seconds, random opens/closes/navigation bursts/pin-unpin/group edits/window moves, staggered offline periods, replay, changed native IDs, and a final operation reaching the peer. Representative run: 831 ms, 805 combined user/adapter mutations, 1,402 persistence boundaries, 260 accepted batches.

17. **70-tab stress.** PASS for the same workload. Representative run: 2,758 ms, 1,067 mutations, 1,419 persistence boundaries, 275 batches. Seventy tabs is a supported normal workload. Real Chromium also passed the 70-tab stage and rapid 50-tab close burst.

18. **200-tab stress.** PASS for the same workload. Representative run: 12,375 ms, 1,624 mutations, 1,415 persistence boundaries, 285 batches. Real Chromium passed 200 live tabs, five windows, twenty groups and native restoration. Model tests use real capture/reconcile/reducer logic with a stateful simulated browser; controller transport tests use mocks; Chromium tests use real extension crypto and a local Durable Object.

19. **Reconnect tests.** PASS: socket close/error/stale/connecting timeout, unstable opens with backoff, healthy connecting retention, offline retry suppression, held response and remote edit before reopening, local offline journal recovery and the next normal synced tab. Laptop sleep timing is simulated in authentication tests, not physically exercised.

20. **Worker restart.** PASS: mocked durable-load/recovery coordination plus real Chromium worker termination and subsequent synchronization. A separate test retries aborted storage loading. Actual OS sleep, extended worker suspension under memory pressure and alarm-only recovery without any UI remain manual checks.

21. **Browser restart.** PASS: fresh worker/extension load tests, the real browser-close/reopen stabilization scenario, and a dedicated `--restore-last-session` Chromium test. Native restoration created no duplicate canonical tabs in the tested 200-tab scenario; local collapse survived and the next navigation synced.

22. **Mass close.** PASS: real rapid 70-tab creation, closure of 50 leaving 20, remaining closure, and another synced tab. A non-last window emits one logical deletion. Final-window and near-simultaneous multi-window shutdown preserve canonical state, followed by reopening and further synced work.

23. **Lint.** `pnpm lint`: PASS. The checkout had CRLF-only formatter failures in otherwise unchanged files; local line endings were normalized without content/UI changes.

24. **Typecheck.** `pnpm typecheck`: PASS.

25. **Tests.** `pnpm test`: PASS, 166 extension/shared/protocol/crypto tests plus 9 server tests (175 total). The full Chromium suite passed all eight tests; authentication/reconnect scenarios were rerun after the expiry fix. Focused scale and controller regressions also passed. No required suite was skipped.

26. **Build.** `pnpm build`: PASS, including the production manifest/bundle audit. This builds the production extension, dry-runs the Worker bundle and audits the output; it does not deploy.

27. **Files changed in this pass.** Extension: `api.ts`/tests, `background.ts`, `browser-events.ts`, `browser-model.ts`, `browser-runtime.ts`, `browser.ts`/tests, `controller.ts` plus new tests, `failure-policy.ts`/tests, `group-browser.ts`, `group-model.ts`, `navigation.ts`/tests, `serial-task-queue.ts`, `socket-lifecycle.ts`, `storage-runtime.ts`, `vault.ts`, `workspace-lifecycle.ts`, `scale.test.ts`, `reliability-stress.test.ts`. Test support: `tests/simulated-browser.ts`, `tests/browser-fixture.ts`, `tests/e2e/connection-recovery.spec.ts`, `scale-restore.spec.ts`, `stabilization.spec.ts`, and the asynchronous assertion in `popup-approval.spec.ts`. Documentation: this report and `ARCHITECTURE.md`. Existing restore commits remain part of the PR.

28. **PR.** [PR #4](https://github.com/jayamartinez/relay/pull/4), targeting `feat/relay-v1`. Continue the existing reliability branch; do not merge this PR or PR #1.

29. **Manual test plan.** Follow the steps below. No developer manual pass has been claimed.

30. **Working tree.** The final `git status --short` result is recorded in the handoff after committing and pushing only reviewed task files. Generated output/server test data are ignored.

## Measurement notes

Same-process restore fixture, twenty samples each, five windows, duplicate URLs, pins and changed native group IDs:

| Tabs | Groups | Before mean | After mean |
| --- | --- | --- | --- |
| 1 | 0 | 0.28 ms | 0.31 ms |
| 20 | 5 | 0.96 ms | 0.82 ms |
| 70 | 25 | 2.73 ms | 1.88 ms |
| 200 | 65 | 10.64 ms | 4.06 ms |

These approximate times include test assertions and vary with host load; they are not pass/fail timing budgets. Churn uses 300 logical one-second steps, accelerated rather than five minutes of wall-clock browser execution. Mutation bounds and convergence assertions are enforced. UUID tie-breaking can slightly vary counts. Final state contains no duplicate logical bindings or missing canonical tabs, and every run proves one more operation syncs.

## Manual test plan and remaining limits

1. Build/load the intended extension channel in two disposable Helium profiles. For local testing run `pnpm build:extension:dev`, start `pnpm dev:server`, load `apps/extension/dist`, and select `http://localhost:8787`. Pair normally. Final build output is production, so rebuild development before choosing a local server.
2. Verify one tab, then 20, 70 and 200 tabs, five normal windows, at least twenty groups, duplicate URLs, pins and different local collapse choices. Change one URL/title/color/membership and move a tab between windows; both devices should converge without repeated reloads or regrouping.
3. At 70 tabs, close 50 rapidly. Verify exactly twenty remain in that set, then open another tab and verify it syncs. Close a non-last window; verify one logical window disappears. Keep a protected settings/file page to verify local-only pages stay local.
4. Turn off device A's network. On B open/close/navigate tabs and edit group metadata; also open/navigate on A while offline. Restore A's network. Expect automatic convergence and an empty journal, without clicking Reconnect. Immediately perform another operation. Repeat with devices reversed and with changes made while A is reconnecting.
5. Pause A. Local structural edits should continue journaling; it sends/applies no network sync while paused. Change B, resume A, verify reconnection and reconciliation, then test another edit. Collapse remains local throughout.
6. Enable Chromium/Helium “Continue where you left off.” Quit A normally with 200 tabs and collapsed groups. Change B while A is closed. Restart A; let native restoration settle. Check tab/group counts and URL multiplicities, local collapse, then make another synced navigation. Repeat with all windows quit together, and repeat extension reload and worker termination.
7. Suspend/resume the laptop and disable/enable Wi-Fi repeatedly, including during initial connection and authentication. Leave Relay running overnight. Expect automatic recovery after scheduling/network resumes; alarms may be delayed by the OS. Check that no repeated Reconnect action is needed.
8. Inspect development-only runtime counts/error categories for persistent growth or halt. They contain no URLs, group titles, account IDs, IPs or keys. Do not copy full workspace/account status into diagnostics reports.

No general promise can be made that browser shutdown is distinguishable from arbitrarily staggered intentional window closures: Chromium has no definitive process-exit event. The existing 1.2-second classification window passed the tested final/rapid multi-window shutdown cases; very staggered shutdown remains a limitation. A crash exactly between a browser create and durable returned-ID persistence is still not an atomic transaction. Extremely delayed native restoration beyond the bounded settling window, real Helium/OS sleep behavior, multi-day sessions and Cloudflare production idle/network closures need hands-on validation. No production deployment or protocol change was made.

**Confirmed within the automated coverage:** ordinary socket/network/worker disruptions recover automatically; one rejected task cannot poison the queue; known transient failures do not permanently halt live sync; remote changes during reconnect are retained; 70 tabs is normal and 200 is tested; tested native restoration creates no duplicates; tested shutdown preserves canonical workspace; collapse stays local; security validation and server/protocol behavior are not weakened. PR #4 has not been merged.
