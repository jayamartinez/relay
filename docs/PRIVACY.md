# Relay privacy policy draft

This is a basis for a future public service/Web Store policy, not a statement that a hosted service exists. An operator must add its identity, contact, hosting region, retention/deletion process and policy effective date before publishing.

## Purpose and local processing

Browsing data is used only to provide the synchronization feature. Relay observes normal tab/window structure, web URLs, pinning/order and user-supplied device names. Experimental group-enabled builds also observe and encrypt live-group titles, colors, ordered membership and window association. Collapsed state is stored only locally. Relay does not inspect webpage DOM/content, inject scripts/UI, synchronize incognito, or collect webpage titles. Cookies, passwords, login/session state, page storage, files, downloads, bookmarks and history are not synchronized.

Protected URLs and file paths are discarded by classification and have no remotely visible resource or reserved position. Friendly names are encrypted. Account number, key material, mappings, journal and cached state remain local in an encrypted IndexedDB vault; non-extractable private CryptoKeys are also stored there.

## Server can see

- Opaque SHA-256 account handle, opaque device IDs and public signing/agreement keys.
- Encrypted recovery package, encrypted root-key boxes, encrypted workspace snapshots/operations.
- Membership/epoch history, canonical revisions, sequence watermarks, approximate ciphertext sizes, request timing and connection/presence metadata.
- IP address during networking and edge rate limiting. Infrastructure/reverse proxies may log IPs unless the operator configures otherwise.

The server does not need the raw displayed account number.

## Server cannot read from stored encrypted content

- Web URLs and workspace contents, including tab structure carried in encrypted payloads.
- Friendly device names.
- Recovery secret, root workspace key or recovery private/wrapping keys.

Webpage titles and local file paths are not uploaded at all. Live-group titles are uploaded only inside ciphertext when that feature is enabled. The server still knows operational metadata; “the server knows nothing” would be an inaccurate claim.

## No secondary use

No advertising, sale of data, behavioral profiling, browsing analytics or production telemetry is implemented. Local development counters contain counts and byte sizes, not URLs or secrets. Cloudflare/Wrangler development tooling has its own vendor telemetry controls; that is separate from extension runtime behavior. To opt out during development, set `WRANGLER_SEND_METRICS=false` in your shell.

## Retention, control and deletion

Pause stops Relay's network connection but keeps local queued changes for resume. Revocation rotates future encryption keys; an online cooperating device best-effort clears local Relay data after verifying its removal. It does not close browser tabs. Uninstalling removes the extension's profile storage according to browser behavior; saved recovery text files and backups are outside Relay's control.

The coordinator keeps the latest encrypted snapshot, at most 512 uncheckpointed operations, signed membership history (up to 1,000 transitions), operational counters and expiring enrollment/auth state. Expired transient rows are pruned on requests. This early implementation does not include an account-deletion UI/API. Self-hosting operators can delete the relevant Durable Object storage, but must handle backup retention themselves. A public service must implement and disclose a complete deletion workflow before launch.

## Permissions

Relay requests `tabGroups` to query and modify supported live groups when the browser provides the API. No browser-internal profile or saved-folder storage is accessed.

`tabs` allows reading URLs/structure and manipulating tabs. `webNavigation` supplies top-frame commit and redirect metadata for navigation loop suppression; Relay still reads no page content. `storage` maintains the browser-session marker and supports Relay storage cleanup. `alarms` provides restart/reconnect fallback. Host access is limited to the configured server; custom HTTPS origins are requested deliberately. Development builds additionally grant loopback HTTP origins. No content scripts, debugger, cookies, webRequest, history, bookmarks, scripting or notification permission is requested.

Relay is independent and is not affiliated with or endorsed by Helium.
