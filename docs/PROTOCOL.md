# Relay protocol v1

All routes are beneath `/v1/{64-character-account-handle}/`. Request bodies are JSON `{payload, proof?}`; all ordinary actions use POST. HTTPS is required outside loopback/private-LAN development. Responses are `no-store`. Public operational fields contain no tab URLs, titles, file paths or friendly device names.

## Authentication

An authorized client asks `challenge` for `{device,purpose,digest}`. `digest` is standard-base64 SHA-256 of canonical JSON of the complete action payload. The response binds version=1, account, device, purpose, random nonce, issued-at, expiry and digest. The device checks all those fields and signs them with P-256 ECDSA/SHA-256. Challenges last 30 seconds and tolerate at most 120 seconds of client/server clock skew; they are still consumed once by the server. The action's proof is `{challenge,signature}`.

The coordinator persists and consumes challenges once, even for a failed signature attempt. Expiry is 30 seconds. Recovery challenges use the reserved actor `recovery` and are valid only for `recover-join`. No account number, opaque device ID or permanent bearer token grants authorization.

## Operations and snapshots

An envelope is `{header,cipher:{nonce,ciphertext},signature}`. Header fields are `version, account, epoch, sender, sequence, base, type`. `type` is `operation` or `snapshot`. The whole header is AES-GCM AAD, and the device signs `{header,cipher}`. Operation IDs, logical resource IDs, actions and resource contents remain encrypted.

An operation plaintext has `id, sender, sequence, base, changes[]`. Changes currently cover window create/delete, tab create/delete/navigate/move/pin, and device-name updates. Snapshot plaintext includes protocol version, workspace ID, canonical revision, logical windows/tabs, encrypted names and sender sequence watermarks. Runtime parsers reject unsupported actions and unsafe web URLs before browser calls.

`push` checks epoch, sender signature, authorization and sender sequence. Each newly accepted envelope gets the next canonical revision. A repeated sequence is acknowledged without appending. Gaps are rejected. Clients cross-check the sender/sequence/base in decrypted payloads and headers, and maintain sequence watermarks across snapshots. A forged cleartext queue acknowledgment cannot clear an unacknowledged local entry.

`sync` takes `{since,generation,force?}`. It returns the current control, subsequent signed controls, optional encrypted snapshot, contiguous operation rows, latest revision, own accepted sequence, pending enrollments and presence. If `since` predates the checkpoint, or force is requested, the latest snapshot precedes later operation rows. A newly paired/recovered client requests a full snapshot before merge.

`checkpoint` accepts a signed encrypted snapshot only when its header base equals the current canonical revision and its epoch is current. It then prunes earlier operations transactionally. The coordinator cannot decrypt/check snapshot semantics; authorized clients are trusted to checkpoint the verified canonical state. The operation log is limited to 512 entries until a client checkpoints. An offline client downloads the checkpoint rather than requiring permanent retention of every operation.

Conflicts use last accepted canonical revision for non-destructive changes. Stale tab deletion is ignored if a different sender changed the tab since its base revision; the same sender can complete its own ordered offline create/edit/delete sequence. `window-delete` is one transaction that cascades its tabs/groups unless a peer changed a child after the operation's base. The adapter never closes unrelated local tabs. Updates cannot resurrect a missing resource. This pre-release semantic update requires all paired clients to be upgraded before resuming sync. See [architecture](ARCHITECTURE.md).

## Additive live-group workspace schema

Relay reads legacy group-free schema-1 snapshots and upgrades the workspace to schema 2 when groups are first introduced. Schema 2 requires `groups`, with stable Relay IDs, window IDs, bounded title/color, ordered member tab IDs and revision/writer metadata. Group operations are `group-create`, `group-title`, `group-color`, `group-members`, and `group-delete`. Collapse/focus/native group IDs never enter the encrypted workspace. Routes, crypto envelopes and membership controls remain version 1. Unsupported schema/actions fail closed; upgrade all devices before enabling groups. See [architecture](ARCHITECTURE.md) for invariants and reconciliation boundaries.

## Membership control chain

Control records include version, account, generation, previous signed control hash, key epoch, actor, opaque member IDs/public keys, immutable recovery public data/encrypted blob, root boxes, and signature. Genesis has generation 0, previous=`genesis`, epoch 1, and one self-signing creator. Additions change exactly one member without changing epoch or existing boxes. Revocations remove exactly one member and increment epoch. Public keys of retained members cannot change. The server and clients validate these rules and signatures.

Existing clients pin the last verified control. A new paired client pins the approving device's signed head after matching SAS; recovery verifies a full chain whose recovery identity matches the secret-decrypted package. New controls are limited to 1,000 generations per account in this development protocol. There is no server-authorized unsigned key list.

## Pairing state machine

The requester signs a short-lived proof for each `pair-read` and `pair-reveal`, binding account, action, request ID, nonce, expiry and (for reveal) the complete reveal. These client-generated expiries use the same 120-second clock-skew bound as challenge validation: `serverNow - 120000 < expires <= serverNow + 30000 + 120000`. Used proof nonces remain stored until `expires + 120000`, including when the requester's clock is behind, so a proof cannot become replayable within its acceptance window. This is separate from the approximately ten-minute pairing-request lifetime. Signature, commitment, SAS and signed-membership checks remain mandatory.

```text
requester                       coordinator                     approver
commit ephemeral + random ──── pair-start ─────────────────────► Review
                               pending, ~10 min                 pin request
                            ◄─ pair-offer ◄──────────────────── commit + pin
pin first offer
reveal ─────────────────────── pair-reveal ────────────────────► check commitment
                            ◄─ pair-answer ◄─────────────────── reveal
check commitment; derive SAS                                  derive SAS
              human compares the SAME code on both screens
                            ◄─ pair-approve ◄────────────────── signed addition + root box
confirm matching code
unwrap own root; verify snapshot; choose Merge
```

Requester public identity and its commitment are signed in `pair-start`. The approver's offer/actions use normal challenge authentication. The requester signs short-lived, nonce-bound `pair-read` and `pair-reveal` requests with its own key; those proofs cannot authorize workspace access. Neither friendly names nor page information appear in a pending request.

Both participants pin the initial identities, expiry and commitments before revealing their ephemeral public keys/random values. The approver persists the entire requester commitment context; it refuses subsequent server changes. The transcript binds both separate device signing and agreement public keys, not just ephemeral keys. This prevents late identity substitution after commitments. A six-digit SAS is derived from the shared secret and transcript, not generated by the server.

`pair-deny` and `pair-approve` are one-time transitions out of pending. Expired requests cannot be read or approved. The first approver owns a review; another authorized device may deny it but cannot silently replace its offer. Lost/expired review keys require denying/restarting the request. Unapproved devices never receive a socket or readable workspace key.

The joining page polls the signed pairing endpoint every three seconds **only while visible**. An authorized profile receives pending-request hints on its socket. There is no unauthenticated permanent websocket. If another device is unavailable, users can wait or enter the recovery key.

## Recovery and revocation

`recover-info` returns public recovery metadata, encrypted recovery blob and signed chain. Account knowledge permits this rate-limited read, not decryption. The client decrypts recovery private keys locally, unwraps the latest root box, and signs a single-member addition through `recover-join` using the recovery signing identity.

`rotate` atomically verifies and commits the next signed membership control, encrypted current snapshot at a new epoch, and log pruning. The client wraps the independent new root only to retained devices plus recovery. Cleartext payloads contain no new root. Removed devices are disconnected and cannot request new challenges. An online removed client receives the signed chain, verifies its own removal and best-effort erases its Relay vault; browser tabs remain.

Epoch changes while a device is offline are verified on reconnect. Queued local edits are encrypted with the new root only after the new membership is trusted and the current snapshot has been verified. Old-epoch submissions are rejected. Revoked clients must not automatically discard local data based only on an unauthenticated 403; a verified removal is needed for automatic wipe.

## WebSocket and limits

`socket-ticket` uses device authentication and returns a random single-use 30-second ticket. GET `socket?ticket=...` consumes it to upgrade, permits one socket per device, and stores the device identity in an attachment. The ticket is short-lived transport bootstrap, not persistent authentication. Avoid logging ticket query strings at reverse proxies.

`ping` / `pong` use the hibernation auto-response mechanism every 25 seconds. `changed` is a hint to perform signed HTTPS catch-up. The only substantive server socket message is `{type:revoked,chain}`; clients verify it before erasing anything. Arbitrary client websocket messages close the connection.

Operational limits: 16 devices, 8 pending requests, 2 MB incoming request bodies, 512 uncheckpointed operations, 1,000 membership generations. Account buckets separately bound create, enrollment, recovery, challenge and pairing reads. Edge limits additionally bound all requests per IP and impose a lower enrollment/read-recovery quota. These reduce abuse but are not a completed production cost-control plan.

Protocol/version mismatches, missing revisions, invalid ciphertext/signatures and unexpected key changes stop sync and preserve local data. No automatic reset is performed on decryption failure. Malicious-server forks and fresh-device rollback cannot be fully prevented without an independent transparency/consistency service; see the threat model.
