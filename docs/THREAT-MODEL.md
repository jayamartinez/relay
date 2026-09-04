# Threat model

Relay assumes a trusted browser, installed extension build, operating system and authorized account devices. The coordinating service and its database are not trusted with plaintext synchronized content or key escrow. TLS still matters for traffic protection, endpoint authentication, metadata and preventing network disruption.

| Threat | Implemented boundary | Remaining limit |
| --- | --- | --- |
| Server/storage compromise reads browsing data | AES-256-GCM with roots generated on clients; independent ECDH boxes; encrypted recovery private keys | Public membership, traffic size/time, revisions and IPs remain visible |
| Account-number guessing grants access | Number only locates handle; pairing or recovery signature and secret required | Account existence and public operational records can be queried subject to limits |
| Enrollment MITM | Two-sided committed ephemeral exchange; pinned identity/transcript fields; matching SAS; signed membership head | Human must compare, reject mismatches and avoid unsolicited approval; six-digit SAS is probabilistic |
| Server substitutes keys at revocation | Retained client-pinned keys and signed previous-hash membership chain | A malicious authorized administrator can legitimately enroll another device/share keys |
| Replayed auth or mutation | Payload-bound, expiring one-use challenges; durable sender sequences; encrypted sequence watermarks | Malicious relay can deny service, delay, fork or present some valid historical views |
| Revoked device receives new state | Independent new root, retained-device-only boxes, new-epoch snapshot, old-epoch rejection | Cannot erase history already decrypted; recovery-secret possession remains an independent authority |
| Remote wipe abuse | Wipe only after validating a chain removing this device | Offline, modified or compromised clients can ignore wipe; no guaranteed erasure |
| Accidental echo/deletion | Serialized adapter, durable mutation expectations, diff baseline, sequence dedup, identity-checked closes, repeated-navigation pause circuit | Chrome/storage are not transactional; browser crashes/drag races need manual validation; redirect detection is heuristic and may pause legitimate edits |
| Passive network observer | HTTPS/WSS in production; content additionally E2EE | Endpoints, timing/volume can still be inferred |
| Local browser profile theft | Non-extractable private CryptoKeys and encrypted local state | An attacker able to run the browser as that profile can invoke keys; this is not an OS keystore or password lock |

## Explicit non-goals

No protection is promised against a compromised OS, malicious browser, malicious installed extension build, or compromised build/release pipeline. Device malware can see the decrypted browsing state or use non-extractable keys. Historic secrets may persist in backups, browser data and memory. There is no forward secrecy ratchet, hardware-backed attestation or guaranteed memory zeroization.

Current members are equally privileged administrators. A hostile authorized device can modify snapshots, share keys, rename/revoke peers or approve another device. Relay v1 is single-account device synchronization, not mutually distrustful collaboration.

A malicious server can suppress revocations to disconnected peers and keep those peers on an old fork. Devices that have accepted a new epoch will not send new-epoch keys to revoked members, but clients unaware of a withheld revocation may continue operating on their old view. No protocol without independent consistency witnesses can guarantee instantaneous global revocation against such server equivocation. Pinned control hashes catch rollback/forking against a client's known head; a fresh recovery installation cannot independently know which historically valid head is latest.

## Release gates

Obtain independent review of transcript commitment/pinning, membership-chain validation, recovery authority, nonce policy, local crash journaling, and malicious-server cases. Add fuzzing/property tests and a reproducible release pipeline. Validate actual Helium on all target OSes, browser restore/drag/sleep races and large workspaces. Configure a real security reporting channel, dependency review, host abuse controls and operational deletion/retention policy before public service.
