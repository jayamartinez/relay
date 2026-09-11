# Relay

Relay is an open-source browser extension and Cloudflare Worker for synchronizing tabs, windows, and supported tab groups across Chromium-based browsers.

## Why Relay exists

Browser sync is usually tied to a vendor account and often exposes more browsing data than a self-hosted tool should. Relay keeps the synchronized workspace encrypted on the client, uses a small coordination service to move ciphertext between authorized devices, and continues recording local changes while a device is offline.

## Current features

- Syncs HTTP/HTTPS tabs, remote PDFs, new tabs, multiple windows, navigation, ordering, pinning, cross-window moves, and closure.
- Syncs supported tab groups, including title, color, membership, grouping, ungrouping, and cross-window structure. Collapse state remains local.
- Queues encrypted local changes while offline and reconciles them after reconnecting from canonical revisions and checkpoints.
- Pairs devices through an approval flow with a committed, user-verifiable six-digit SAS.
- Supports recovery enrollment, device revocation, per-device key provisioning, and best-effort online vault wipe.
- Avoids syncing local-only and protected tabs; it does not create placeholders for them.
- Persists the local journal, workspace state, device identity, and browser-to-workspace mapping in an encrypted local vault.
- Uses durable mutation expectations, sender sequence numbers, and a bounded navigation circuit to reduce sync loops and stale destructive updates.

The following are intentionally not synchronized: active-tab focus, window geometry, scroll position, incognito state, cookies, logins, site storage, bookmarks, and history. Browser-internal, file, extension, and other protected pages stay local.

## How it works

```text
Browser extension A                                      Browser extension B
tabs/windows + groups                                   tabs/windows + groups
        │                                                        │
        └── encrypted local vault + Web Crypto ──────────────────┘
                              │
                    HTTPS requests / WebSocket hints
                              │
                    Cloudflare Worker + Durable Object
                    ciphertext, revisions, public controls
```

The extension captures browser events, applies them to a local journal, and sends signed encrypted envelopes to the account’s Durable Object. The server assigns canonical revisions, stores encrypted operations and checkpoints in SQLite-backed Durable Object storage, and uses hibernating WebSockets only for change hints and revocation notices. Clients pull, verify, decrypt, and reconcile the canonical state.

Concurrent non-destructive edits resolve by accepted server revision. Stale deletes are rejected when a peer changed the resource after the operation’s base revision. Durable expected-mutation records, identity checks, and sequence watermarks prevent remote updates from being mistaken for new local edits.

## Security and privacy

- Workspace data is encrypted on devices with AES-256-GCM. The Worker coordinates ciphertext and cannot decrypt synchronized tab data.
- Device signing and agreement keys use P-256 ECDSA/ECDH. Private device keys are non-extractable CryptoKeys stored in the browser’s IndexedDB-backed vault.
- Device names and membership metadata are carried in signed control records and encrypted where they are part of workspace state; pending pairing requests do not expose friendly names or page data.
- A new device must be approved by an authorized device. Pairing commits both sides of an ephemeral exchange and requires matching SAS values before workspace keys are provisioned.
- Revocation creates a new workspace-key epoch and reprovisions only retained devices. An online revoked device verifies the signed removal chain, clears its Relay vault, and disconnects; its browser tabs are left open.
- The account number identifies a server-side Durable Object but is not an encryption key or authorization credential. Recovery uses a separate secret and signing identity.

Relay still assumes the browser, operating system, installed extension, and authorized devices are trusted. The server can observe traffic metadata, timing, sizes, revisions, IP addresses, and public membership records. See the [threat model](docs/THREAT-MODEL.md) for the remaining limits.

## Repository and stack

- `apps/extension` — vanilla TypeScript browser extension, popup, settings, onboarding, browser adapters, local vault, and sync lifecycle.
- `apps/server` — Cloudflare Worker and `RelayAccount` Durable Object with SQLite storage, rate limits, HTTP synchronization, and hibernating WebSockets.
- `packages/protocol` — validated wire messages, encrypted workspace envelopes, membership controls, reconciliation, and tab-group state.
- `packages/crypto` — Web Crypto primitives, envelopes, key wrapping, recovery, and committed pairing.
- `packages/shared` — URL policy, configuration, limits, and shared validation.

The project uses TypeScript, pnpm workspaces, Web Crypto, Cloudflare Workers/Durable Objects, Wrangler, Vitest, Playwright, and Biome.

## Development

Requirements: Node.js 22.12 or newer and pnpm 10.20.0.

Install dependencies and start the local Worker plus development extension build:

```sh
pnpm install
pnpm dev
```

Load `apps/extension/dist` as an unpacked extension in two separate Chromium browser profiles. During setup, choose `http://localhost:8787`. Local Wrangler state is kept under `apps/server/.wrangler/state` when using the LAN server mode.

Useful checks:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For the browser end-to-end suite, keep the local server running, install the Playwright browser once, and run:

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

See the [development guide](docs/DEVELOPMENT.md) for the two-profile workflow and manual scenarios. See [self-hosting](docs/SELF-HOSTING.md) for Cloudflare deployment and custom Worker origins.

## Project status

Relay is functional pre-release software (`0.1.0`) and has not had an independent security review or Chrome Web Store release. The current implementation is a single-account device synchronization system; authorized devices are equally privileged. Account migration, bookmarks, history, nested groups, Firefox support, forward-secrecy ratcheting, and guaranteed remote erasure are not implemented.

Further design detail is available in the [architecture](docs/ARCHITECTURE.md), [protocol](docs/PROTOCOL.md), and [cryptography](docs/CRYPTOGRAPHY.md) documents.

## License

Relay is licensed under [AGPL-3.0-or-later](LICENSE). See [TRADEMARKS.md](TRADEMARKS.md) for branding notes. Relay is independent of Helium and is not affiliated with or endorsed by Helium.
