# Relay

Your Helium workspace, everywhere.

Relay synchronizes browser tabs and windows between computers without a Google account, email address, or password. Workspace contents are encrypted on-device before they reach the relay service.

Built for Helium. Works with compatible Chromium browsers.

**Early v1 implementation · version 1.0.0 · working product name.** This is functional development software, not an audited or Chrome Web Store-approved release. Use disposable profiles for initial testing. No official hosted service is configured or claimed.

## What works

- Anonymous 24-digit accounts; a separate 256-bit recovery code.
- Device signing keys, committed SAS pairing, recovery authorization, encrypted names, signed membership history.
- HTTP/HTTPS tabs, remote PDFs, new tabs, multiple windows, navigation, ordering, pinning, cross-window moves, and closure.
- Local-only/protected tabs stay local and create no remote tab or placeholder.
- Persisted encrypted local journal, canonical server revisions, checkpoint snapshots, reconnection and pause/resume.
- Device revocation with a new workspace key, per-device key provisioning, and signed best-effort online wipe that leaves browser tabs open.
- Vanilla TypeScript popup and settings/onboarding; no content scripts, remote fonts, UI framework, or runtime analytics.
- A local Cloudflare Worker with SQLite-backed Durable Objects and hibernating WebSockets.
- Tab groups when the browser exposes the supported APIs: title/color, ordered membership, grouping/ungrouping and cross-window structure. Collapse stays local.

Active tab, focus, geometry, scroll position, incognito, cookies, logins and site storage are **not** synchronized. A joining one-window device appends its portable tabs to the existing one-window workspace; enrolled restart recovery reuses canonical window IDs and favors preservation.

Screenshots: capture the onboarding, popup and device approval screens after final visual review. Automated development screenshots are generated under `output/playwright/`, not bundled in the extension.

## Run locally

Requires Node.js 22.12+ and pnpm 10.20+. No Cloudflare account is needed for local testing.

```sh
pnpm install
pnpm dev
```

`pnpm dev` builds a development extension and starts Wrangler on `http://127.0.0.1:8787`. Load `apps/extension/dist` unpacked in **two separate browser profiles**. Choose `http://localhost:8787` during setup.

For two physical computers on a trusted LAN, first run `pnpm build:extension:dev` and reload the unpacked extension. Then run `pnpm dev:server:lan`, allow TCP 8787 through the host firewall for private networks, and use `http://<host-private-IP>:8787` (10/8, 172.16/12, or 192.168/16) on both development extensions. Relay validates that HTTP address before asking Chrome for permission to that one exact origin. Wrangler state persists in `apps/server/.wrangler/state`. Plain HTTP/WS is development-only; production builds still require HTTPS/WSS.

For extension rebuilds in another terminal:

```sh
pnpm dev:extension
```

Reload the unpacked extension after rebuilding. See [the complete two-profile test guide](docs/DEVELOPMENT.md).

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# With pnpm dev:server running in another terminal:
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm build` produces the production extension and a dry-run Worker bundle. It does **not** deploy. The production extension intentionally rejects plaintext localhost servers; use `pnpm build:extension:dev` for local work. Building development and production currently replaces the same `dist` directory.

## How it fits together

```text
Chromium / Helium profile A                  Profile B
tabs/windows ↔ event adapter                 event adapter ↔ tabs/windows
                 ↕                               ↕
       encrypted local journal           encrypted local journal
                 ↕                               ↕
         device-side Web Crypto           device-side Web Crypto
                 └──── encrypted HTTPS / WSS ─────┘
                                  ↕
                        Cloudflare Worker
                                  ↕
                  one SQLite Durable Object/account
              ciphertext · revisions · public membership
```

The account number locates an account; it cannot decrypt it. Authorized devices hold a random workspace root key. Recovery uses an independent secret, and device pairing requires matching codes derived from the actual cryptographic exchange. The server can see traffic metadata and public keys, not readable synchronized browsing data. See [cryptography](docs/CRYPTOGRAPHY.md) and [threat model](docs/THREAT-MODEL.md); do not interpret encryption as protection from a compromised endpoint.

## Repository

`apps/extension` owns browser integration/UI; `apps/server` owns opaque coordination; `packages/protocol` owns validated messages and reconciliation; `packages/crypto` owns Web Crypto constructions; `packages/shared` owns URL/configuration policy.

- [Architecture and restart behavior](docs/ARCHITECTURE.md)
- [Wire protocol and pairing state machine](docs/PROTOCOL.md)
- [Self-hosting](docs/SELF-HOSTING.md)
- [Privacy policy draft](docs/PRIVACY.md)
- [Security reporting](SECURITY.md)

## Release gates and roadmap

Before public v1 release: independent protocol/security review, real Helium testing on Windows/macOS/Linux, sleep/browser-restore/drag-race testing, native permission-dialog testing, deployment abuse/cost review, and a published source/security-contact/privacy-policy URL. Server origin migration and recovery-secret replacement are not implemented in this early v1.

After v1: bookmarks, history, more Chromium compatibility testing, and Firefox investigation. Saved/persistent folders and nested groups remain unsupported by this implementation.

## License and independence

Source code is licensed under [AGPL-3.0-or-later](LICENSE). See [branding notes](TRADEMARKS.md). Relay is a working name, not a claim of registration or exclusive trademark rights.

Relay is an independent project and is not affiliated with or endorsed by Helium.
