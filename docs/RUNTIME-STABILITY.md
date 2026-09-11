# Runtime stability pass

Base: current `origin/main`, `fdf79a8` (PR #13 included). Branch: `fix/runtime-stability`.

## Findings and changes

1. **Navigation feedback:** `tabs.onUpdated` could create a durable local intent for a receiver-side redirect before `webNavigation.onCommitted` supplied redirect metadata. `flush()` could journal that provisional intent. Later capture suppression did not undo the journal. Local journal receipts also claimed redirects as though Relay had called Chrome. Known receipt ownership expired after 15 seconds, allowing delayed callbacks to become local intent. The fixes defer journaling while navigation evidence is pending, retire only the matching unjournaled owned redirect observation, distinguish local journals from remote browser mutations, and retain known destination ownership across sleep/restart until superseded.
2. **Fresh local navigation lost:** commits did not create freshness immediately; capture replaced freshness with an older mapping clone; and navigation checked `allowed()` before receipt persistence but not after its await. A/B/A input also compared only against the old observed A. These paths now protect commits/history events synchronously, preserve concurrent freshness and receipt updates, compare against the current intent, and recheck immediately before `tabs.update`. Window creation checks freshness before its browser mutation too.
3. **Idle UI:** settings polled every three seconds, queried browser topology on every status request, and compared clock-derived diagnostics before `replaceChildren`. Real Chromium detached the idle settings DOM within 6.5 seconds on main. Active settings now use status events, ignore diagnostic ages for view identity, and coalesce overlapping reads. Popup skips equivalent updates. Pairing-only polling remains because a pending requester has no live socket. UI ports reattach with bounded backoff after MV3 restart; connection transitions notify subscribers.
4. **Remote delete:** main already retained failed removals and reread the tab after `tabs.remove`. Those tests pass. An adjacent retry bug remained: a tab already absent could keep reconciliation failing when another tab still needed work. Fresh topology now confirms absence and permits cleanup. Recovery candidates exclude native IDs bound to other logical tabs, and destructive identity checks include the logical window. Ambiguous identity remains safely pending. The exact reported physical-tab-survives failure was not reproduced in two-profile Chromium.
5. **Other correctness fixes:** encrypted snapshots now write in invocation order; capture cannot erase a close received during its await; later navigation callbacks cannot replace a pending close; mapped tabs that become protected/local-only pages cannot be navigated back to web state; and an already-canonical A/B/A intent can settle without blocking reconnect forever. The existing repeated-reversal circuit remains active for repeated site routing away from the same remote target, while explicit address-bar/back input clears its attribution.

The Google-specific infinite loop was **not reproduced**. The deterministic tests establish the feedback/race paths above, not a claim that every Google AI failure has the same cause. The external Google probe encountered CAPTCHA in both profiles on both main and the modified extension. Both runs recorded two receiver applications and zero receiver navigation echoes over five seconds, failing its one-application assertion. No CAPTCHA bypass or sensitive page-content logging was used.

## State-machine boundaries

- Local update/commit/history -> synchronous freshness or receipt classification -> ordered encrypted persistence -> debounced settled capture -> queued operation persistence -> push -> signed canonical pull/sequence validation -> queue retirement -> intent settlement only with matching canonical state and no pending tab operations/evidence.
- Remote notification -> serialized capture/pull -> canonical/projected state -> durable reconcile target/expectations -> browser topology read -> receipt persistence -> fresh `allowed()` check -> browser navigation -> owned callbacks -> observed-state persistence. Callbacks received during awaits retain their newer freshness and receipt state.
- Remote delete -> projected absence -> durable pending target -> identity/topology reread -> `tabs.remove` -> `tabs.get` absence confirmation -> mapping cleanup. Failure or continued presence keeps the mapping and target retryable. Already-absent tabs can complete after a fresh topology check.
- Disconnect -> existing bounded transport backoff/alarm -> hydrate if required -> signed pull/journal recovery -> reconciliation -> LIVE. UI subscription reconnection is separate from workspace transport and never reloads the page.

## Expected-mutation audit

| Mutation | Ownership and consumption | Result |
| --- | --- | --- |
| Navigation | Persisted operation receipt plus known destination/redirect equality; several Chrome callbacks may match one operation | Known callbacks survive TTL; a newer navigation supersedes suppression; previous-page completion cannot complete the new receipt |
| Create | Persisted expected logical create before Chrome, native mapping/receipt after Chrome returns | Existing exact-value suppression retained; freshness checked before missing-window creation |
| Close | Persisted expected delete; retained pending target and post-remove absence reread | Failed/ineffective remove remains pending; already-absent and uniquely rebound cases covered |
| Move/pin | Persisted exact-value expectations, 15-second expiry; repeated matches do not consume early | Existing behavior retained; topology equality makes delayed no-change callbacks idempotent |
| Group | Existing exact group mutation expectations, 15-second expiry, local collapsed state | Semantics unchanged; existing group unit/E2E checks retained |

No new permissions, dependencies, crypto changes, account/pairing changes, Worker changes, or UI design changes. Durable Object heartbeat auto-response already handles `ping`/`pong`; the 25-second client heartbeat and bounded reconnect logic were retained.

## Regression evidence

Eight new cases failed on an isolated copy of main before the fixes. Added deterministic coverage includes provisional redirect journaling, commit-only freshness, A/B/A intent and canonical satisfaction, stale capture losing close intent, ordered persistence, post-persistence stale navigation, stale mapping persistence, known callbacks after sleep, local-journal redirect attribution, protected pages, absent-delete retry, ineffective removes, native-ID ownership, repeated reversal circuit behavior, and equivalent status views.

New two-profile Chromium coverage exercises receiver-side `pushState`/`replaceState`, a second query, a redirect link, convergence without receiver reload, physical remote close, and idle DOM identity. Existing E2E covers real encryption/pairing, offline edits, socket recovery, MV3 termination, native session restore, 20/70/200 tabs, groups, pins/moves, multiple windows, and shutdown preservation.

## Validation and manual verification

- `pnpm lint`: passed (checkout-only CRLF normalization was necessary; no unrelated content changes).
- `pnpm typecheck`: passed.
- `pnpm test`: 215 extension/shared/build tests and 13 Worker tests passed.
- `pnpm test:e2e`: all 11 tests passed in Chromium 151 on Windows against a local Wrangler Durable Object.
- `pnpm build`: passed production extension build, Worker dry-run, and manifest/bundle artifact audit.
- Extended idle run: passed; the original settings DOM stayed attached for 185 seconds (3.1 minutes total test time).
- `pnpm test:google`: failed the one-application assertion on both main and modified code under CAPTCHA; second Google AI query unavailable.

| Area | Automated browser evidence | Remaining hands-on check |
| --- | --- | --- |
| Navigation | Same-tab navigation, rapid A/B/C, push/replaceState, redirect link, zero extra receiver application for synthetic second query | Normal Google results, second Google AI query, real back/forward in Helium |
| Tabs | Local/remote physical close, mass close, reconnect, protected pages; deterministic close-during-navigation | Close during real Google navigation and immediately after laptop wake |
| Reconnect | Socket failure, offline queue, MV3 stop/restart, browser session restore | Actual OS sleep/lock/wake on both devices |
| Idle | DOM identity checked; connection updates and port restart exercised | Leave production settings open while working normally |
| Multi-device | Two disposable profiles: create, navigate, redirect, close, pin, move, groups | Two physical machines with the user's normal workloads |

For hands-on testing, load the built extension on two disposable profiles/devices, pair them, navigate/search repeatedly in one mapped tab, then navigate from the receiving device. Verify the latest local URL remains stable and the other device follows. Close during navigation and after reconnect; confirm the physical peer tab disappears. Open a protected page in a mapped tab and confirm it stays local. Leave settings open for several minutes, disconnect/reconnect, and confirm status changes without page resets. Finally restart the browser and sleep/wake the device; verify no workspace deletion or duplicate tab creation.

Human manual testing has not been reported. Do not merge based solely on these automated checks. Ambiguous stale native identities deliberately remain pending rather than risking deletion of an unrelated tab. MV3 termination before a storage transaction completes is still a durability boundary; the fix prevents out-of-order successful writes, not impossible guarantees about writes Chromium never completed.
