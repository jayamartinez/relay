# Two-profile development and manual testing

Use two **disposable** normal profiles. Do not start with your everyday browsing profile. Unpacked extension IDs should stay consistent by loading the same directory; moving it can change the extension's origin/storage identity.

## Commands

```sh
pnpm install
pnpm dev
```

This builds development output at `apps/extension/dist` and starts the local Worker on port 8787. Alternatively run `pnpm dev:server` and `pnpm dev:extension` in separate terminals; the latter watches extension source. Reload the unpacked extension after a rebuild. Public HTML/CSS edits require restarting the build watcher or running a new build.

For a two-computer LAN test, run `pnpm dev:server:lan` on the host and configure **both** profiles with the same normalized LAN origin, for example `http://192.168.1.50:8787`. Do not use `localhost` on one computer and the LAN IP on the other: those are distinct server origins even when they reach the same Worker. A trailing slash is normalized away.

### Connection diagnostics

The ordinary `pnpm build:extension:dev` build includes **Test connection** in server setup and on draft/active account screens. It requests the selected host permission through a user gesture, then fetches `/health` from the same background service worker used by `/create`. Success requires `{name:"Relay",protocolVersion:1}`, not just HTTP 200. The probe does not change the account's sync state.

Expand **Development connection trace** after a failed action, or inspect the Relay service worker console with verbose/debug messages enabled. Copy only the trace and the visible error, not account/recovery fields or browser storage. The trace contains the canonical server origin, host-permission result, preparation stages, byte count, HTTP status, safe runtime error name/message, and validation codes. Arbitrary error text is withheld because it can contain private data; original exceptions remain attached as `Error.cause`. No request bodies, keys, workspace content or browsing URLs are logged. Successful routine sync requests stay quiet. Production builds omit these diagnostics.

`FETCH rejected — TimeoutError: signal timed out` means fetch was invoked but no response arrived before the 12-second deadline. `ENDPOINT_FAILED`, `SERIALIZATION_FAILED` and `REQUEST_SETUP_FAILED` indicate local preparation problems. `PAIR_REQUEST_TIMESTAMP_INVALID`, `PAIR_PROOF_TIMESTAMP_INVALID` and `CHALLENGE_VALIDATION code=...` identify protocol failures without weakening checks.

If even background `/health` times out, compare a bounded host request (`curl.exe --max-time 5 http://192.168.1.176:8787/health` on Windows). A listening port is not proof that Wrangler is processing requests. Stop/restart Wrangler in its existing terminal if necessary, retaining `apps/server/.wrangler/state`. Do not clear extension storage or delete server state as a networking fix. Restart Wrangler and reload **both** rebuilt extensions before testing a changed protocol implementation.

Open Helium/Chromium's extensions page in both profiles, enable Developer mode, choose **Load unpacked**, and select the same absolute `apps/extension/dist` directory. The minimum supported Chromium API level is 120. Helium variants must actually provide those APIs; this version has automated Chromium evidence, not a completed Helium certification matrix.

On Windows, if your browser executable supports Chromium profile flags, you can launch separate profiles from PowerShell (replace the executable path; this command is not run automatically):

```powershell
& 'C:\path\to\helium.exe' --user-data-dir="$PWD\.profiles\A" --no-first-run
& 'C:\path\to\helium.exe' --user-data-dir="$PWD\.profiles\B" --no-first-run
```

On macOS/Linux, use the browser's profile UI or the equivalent `--user-data-dir` with distinct absolute paths. Never launch a second process using the same profile data directory.

## Account creation and pairing

1. In profile A, open a few harmless HTTP/HTTPS tabs in two normal windows, including duplicate URLs. Open Relay settings.
2. Choose a device name and `http://localhost:8787`, then **Create Relay account**.
3. Copy the account number. Reveal/copy/save recovery information locally. Verify the saved text file includes the account, server and complete code; keep it private.
4. Check the explicit saved-key/workspace confirmation and choose **Start syncing**.
5. In B, leave some unrelated test tabs open. Choose **Enter account number**, paste A's number, use the same server and request approval.
6. In A, choose **Devices → Review**. Keep B's setup page visible during exchange.
7. Compare the six digits on both screens. If they differ, deny/cancel. Only after matching, confirm and **Approve** on A.
8. Confirm the code on B, finish authorization, then **Merge and continue**. Verify B's pre-existing tabs were not deleted and join the logical workspace.

## Workspace checks

- Open a web tab in A; exactly one counterpart should appear in B, without switching B's current tab.
- Navigate it in B; A should navigate the same logical tab. Pin/unpin and reorder it.
- Move it to an existing window, then into a new window. Verify the existing counterpart moves rather than being duplicated.
- Close it. Verify only its mapped counterpart closes. Confirm an unrelated Relay/settings/local tab remains.
- Open two identical URLs. Navigate or close only one; check occurrence/order mapping remains correct.
- Put a local file or browser settings tab between two web tabs. The peer should show only the two web tabs in relative order, with no placeholder or gap. Navigating the local-only tab to a website should then create a normal synced tab.
- Change active tabs, focus, window dimensions and scroll position independently. None should be mirrored. Browser-selected replacement active tabs on closure are expected local behavior.
- Incognito should remain completely outside Relay.

## Tab-group checks

Tab groups are available in normal builds when supported by the browser. Group two harmless tabs in A and confirm B receives one group with matching title, color, and ordered members. Rename/recolor it, move members between groups/windows, and ungroup it; tabs must remain open. Collapse a group on only one device and confirm the peer's collapsed state does not change. Disable Tab groups in B's Settings: tabs must remain while group UI is unmanaged locally; re-enable it and confirm existing mapped tabs regroup without duplicates. Saved/closed groups and nested groups are not synchronized.

## Offline, restart and security checks

- Pause B; modify A and make separate local edits on B. Resume B. Both sides should converge, retaining local queued edits. A stale close must not destroy a newer competing edit.
- Test a synthetic page with conflicting redirects on the two profiles. Three unexpected navigation reversals for one tab within 60 seconds, while recent remote navigation expectations remain active, should pause sync and retain queued changes. Inspect the page before resuming. This is a heuristic; also check that rapid legitimate navigation does not cause an unacceptable false positive.
- Stop Wrangler, make local edits, restart `pnpm dev:server`, then reconnect. Check the queue drains without duplicate operations. Restart preserves state only when the same Wrangler persistence directory is retained. Retry is also available in General settings.
- Close/reopen B's browser and test its native restore behavior, including multiple identical windows. Ambiguous restores may preserve duplicate windows; they must not close uncertain tabs.
- Terminate/restart the extension worker from its developer tools, then change a tab. Verify key/journal persistence. Inspect UI errors rather than clearing storage on a cryptographic failure.
- In A, revoke B. Check epoch increments, B returns to setup if online, and B's actual tabs stay open. It must not receive new encrypted state.
- In a third disposable profile, use the saved account/recovery key. Verify recovery works after rotation. A deliberately incorrect key must fail without resetting local data.
- Test native optional-host permission accept/deny against a real HTTPS self-hosted endpoint. The headless loopback suite does not exercise that browser-native dialog.

## Automated checks

Tab groups are included in every normal build when browser APIs are available. Test the per-device toggle: turning it off leaves tabs intact and unmanaged locally; turning it back on safely projects the canonical structure onto the existing mapped tabs.

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

With the development Worker running separately:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

The end-to-end tests create disposable Chromium profiles, use real extension APIs and the local Worker, and never use everyday profiles. They cover cryptographic pairing, one-window initial merge, one-load navigation, local-only omission, deliberate multi-window changes, final-window and rapid multi-window shutdown, restart identity, offline work, revocation, recovery, and optional groups. Diagnostics are local, bounded, sanitized, and enabled only for this test build. Run `pnpm test:google` separately for the explicit external-network probe.

`pnpm test:e2e` leaves the development build in `dist`. Run `pnpm build` again to inspect production output. No command above commits, pushes, publishes or deploys.

For an isolated Worker, the browser tests accept `RELAY_TEST_SERVER` (for example `http://192.168.1.176:8788`). `RELAY_TEST_EXTENSION` can select an explicitly prepared disposable extension copy. Headless Chromium may leave its native optional-host-permission prompt unanswered; for transport tests only, copy the built extension under `output/`, add the one selected host match pattern to that copy's `host_permissions`, and point `RELAY_TEST_EXTENSION` there. This pregrants permission and therefore does **not** test the native approval dialog. Never copy that test manifest back into `apps/extension/dist` or use it for the physical-device handoff. The normal build continues requesting optional host access from the user.

For the final LAN handoff, run production checks first, then **`pnpm build:extension:dev` last**. Load `apps/extension/dist` on Windows and copy that entire directory (or build the same uncommitted source) on Mac. A Git pull alone will not include local fixes that have not been committed.
