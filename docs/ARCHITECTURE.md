# Architecture

## Boundaries

- **shared:** URL classification, account canonicalization, server-origin policy, validation helpers and bounds. It does not use Chrome.
- **protocol:** wire types, explicit parsers, logical workspace model, deterministic ordered reducer. Future resource actions can extend this package without changing account cryptography.
- **crypto:** Web Crypto only. It knows neither Chrome nor Cloudflare storage.
- **extension:** a serialized MV3 controller, browser adapter, encrypted IndexedDB vault, request client and short-lived vanilla DOM UI.
- **server:** edge routing/rate limits and one Durable Object per hashed account handle. SQL persists membership history, snapshot, operation rows, sender sequence watermarks and expiring challenges/pairing requests/tickets.

There is no content script or page DOM inspection. Webpage titles are not collected. Optional live-group titles are encrypted workspace content. URLs are needed for synchronization but never sent as readable server fields. File paths and protected-page URLs are discarded by the shared classifier; only their classification crosses devices, inside ciphertext.

Live groups extend the same reducer, local journal and adapter when the browser exposes the supported APIs. Group parsing/reduction, observation and native mutation helpers are separated into focused modules. Logical group UUIDs are distinct from native group IDs; collapsed state remains local.

## Tab groups

Relay synchronizes currently open Chromium tab groups when the browser exposes `tabGroups`, `tabs.group`, and `tabs.ungroup`; a missing capability leaves ordinary tab/window sync available. Group IDs, names, colors, ordered membership, and window association are encrypted workspace data. Native numeric group IDs and collapsed state stay local. Relay does not access browser profile databases, saved-group storage, or private APIs; saved/closed groups and nested group structures are outside this scope.

During startup, Relay remaps tabs/windows first and then matches a group only by an exact, unambiguous set of mapped tab IDs. Remote operations record expected mutations before applying browser APIs, so resulting browser events do not echo. Reconciliation can reuse an exact group after an interrupted creation, preserves the device's collapsed state, and ungroups tracked members without closing tabs. A device with group sync disabled keeps the underlying tabs but does not create or emit local group structure.

## Browser model

Logical UUIDs identify windows and tabs, never Chrome IDs. The encrypted local mapping relates session-local IDs to those UUIDs. A `chrome.storage.session` marker distinguishes worker termination from browser-session replacement.

The controller has explicit `UNINITIALIZED`, `LOADING_LOCAL_STATE`, `FETCHING_CANONICAL_STATE`, `RECONCILING`, `LIVE`, and `STOPPED` phases. Browser changes upload only in `LIVE`. URL commits are coalesced independently per tab for 200 ms; close bursts use a 600 ms classification window. Structural events trigger bounded queries, with no workspace polling. Relay does not subscribe to activation, focus, scrolling or geometry.

On a same-session worker restart, persisted mappings remain available. In a replacement session, hydration maps physical windows to existing canonical windows using prior mapping, exact fingerprints, unique overlap, then canonical window order. Duplicate URLs match by occurrence/order. Resume never invents window IDs; excess unmatched physical windows remain ignored until an explicit `LIVE` creation event. Missing startup resources are not deletion evidence.

Only web URLs and semantic new tabs enter the replicated tab set. File, browser-internal, extension, devtools, data, blob, incognito, and unsupported privileged pages are absent—no placeholder or spacing tab is created. Portable indexes count only syncable tabs; local-only tabs keep their own native positions. Legacy extension-owned placeholders are removed during reconciliation.

Remote tab creation is inactive; new windows request `focused: false`. Moving an already-mapped tab into a new logical window reuses that physical tab. Relay never calls `windows.remove` to close unknown local tabs. It removes only mapped tabs whose live identity still matches; a window that retains an unsynchronized settings page stays physically open. Chrome may select a replacement active tab when the current tab closes or moves; that unavoidable browser behavior is not an active-tab synchronization feature.

## Durable journal and reconciliation

The local vault persists canonical workspace/revision, sender sequence, pending operations, mapping, expected mutations, and any in-progress target. Queue entries are saved before upload. Each authenticated sender has a monotonically increasing sequence; the server remembers the high-water mark across checkpoints. A disconnected client retains its journal. Pausing disconnects networking but continues to record local structural edits.

Reconnect first downloads a snapshot if the client's revision predates the retained log, then verifies/decrypts contiguous operations. It projects queued local changes over canonical state and submits them in order. A queue entry is removed only when a decrypted canonical state contains its sequence and the server acknowledges the same watermark. Replies with missing/replayed operations, invalid signatures, mismatched epochs or stale snapshots fail closed.

Canonical ordering is assigned by the coordinator, not wall-clock timestamps. Concurrent non-destructive edits resolve by later accepted revision. A local tab close emits one `tab-delete`. A non-final window close emits one cascading `window-delete`, not child deletes; a concurrent peer tab edit prevents the stale cascade. Sequential edits from the same sender may delete that sender's own last-written resource. Relay removes only tracked children and never calls `windows.remove` on a window that can contain local-only tabs.

Snapshots checkpoint canonical—not optimistic/queued—state after roughly 64 accepted operations. A checkpoint is accepted only at the current server revision. The server prunes operations only after that check. At 512 uncheckpointed operations it requests a checkpoint before accepting more. Control history is retained up to 1,000 transitions; current membership is capped at 16 devices. Workspace bounds are 100 logical windows/2,000 tabs and 2,000 queued batches. These are development limits, not tested scale promises.

## Loop prevention and crashes

Remote changes have persistent expected-mutation records containing operation ID, resource, mutation type, expected value and a 15-second expiry. Navigation receipts additionally contain local/logical tab IDs, normalized expected/previous/settled URLs, source, and bounded known redirects. They survive asynchronous loading/complete callbacks. Relay checks the live URL before `tabs.update`, records intent before browser calls, and coalesces committed—not provisional—URLs. Sender sequence watermarks make network replays idempotent.

A bounded navigation circuit also tracks unexpected local navigation while a recent remote create/navigation expectation is active. Three such reversals for the same logical tab within 60 seconds automatically pause networking and retain queued edits, with a visible error. This heuristic limits common sign-in redirect/conflicting-edit feedback; it can pause legitimate rapid navigation and does not detect every possible redirect loop. The user must inspect the affected pages before resuming.

The browser APIs and IndexedDB cannot participate in one atomic transaction. A crash between a browser creation and saving its returned ID can still leave an orphan/duplicate. Relay favors preserving such tabs. `isWindowClosing` plus a 600 ms all-normal-windows query distinguishes a final/rapid browser exit from one-window deletion; `STOPPED` preserves prior mapping and canonical state. Chromium exposes no definitive “browser process is exiting” extension event, so unusually staggered closes beyond that window remain a limitation.

At enrollment, a joining device's sole normal window maps to the sole canonical window and appends its own portable tabs; equal URLs are never deduplicated. On restart, missing startup resources are not deletion evidence. Browser-internal, file, incognito, extension, data, blob, and other protected tabs are never Relay resources or placeholders.

## Transport and resource use

Signed HTTPS requests carry ciphertext mutations. A one-use, 30-second ticket upgrades an authenticated WebSocket; messages broadcast only a change hint or a signed revocation chain. Clients retrieve canonical encrypted data through authenticated requests. Every connected device sends `ping` each 25 seconds. The Durable Object auto-responds `pong` through the hibernation API, without running application code for that heartbeat.

All durable coordinator state lives in SQLite. Runtime object fields are not relied on after hibernation. Short HTTP actions are serialized inside `blockConcurrencyWhile`; responses are bounded, and network request bodies are streamed with a 2 MB limit. Backoff is exponential with jitter, capped near five minutes. A one-minute alarms watchdog wakes a terminated worker but performs no tab/server query while already connected. A socket with no received message for over 75 seconds is reconnected. No socket is opened for anonymous, draft or pending devices, or while paused.
