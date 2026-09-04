# Self-hosting

Relay uses one Worker and SQLite-backed Durable Objects. No VPS, Redis, PostgreSQL, Docker, email provider or OAuth provider is required.

## Local development

```sh
pnpm install
pnpm dev:server
```

The second command runs `wrangler dev --ip 127.0.0.1 --port 8787` from `apps/server`. Local state persists in that application's `.wrangler` directory. Keep it if you want accounts to survive server restarts. Do not expose this development server on a public network.

In another terminal:

```sh
pnpm build:extension:dev
```

Load `apps/extension/dist` unpacked. Use `http://localhost:8787` or `http://127.0.0.1:8787` consistently. Accounts are server-specific; those origins should not be casually interchanged in a configured profile.

## Production deployment — not executed by this project setup

You need a Cloudflare account with Workers/Durable Objects access and suitable plan/limits. Confirm current [Cloudflare requirements](https://developers.cloudflare.com/durable-objects/platform/pricing/) before deployment. `apps/server/wrangler.jsonc` defines `ACCOUNTS`, SQLite migration `v1`, and edge rate-limit bindings. Initial deployment runs the migration for the exported `RelayAccount` class.

After security/manual testing and **your explicit deployment decision**:

```sh
pnpm --filter @relay/server exec wrangler login
pnpm --filter @relay/server exec wrangler deploy
```

No root/recovery/device secrets belong in Worker variables. TLS must terminate at a trusted endpoint. Use the returned HTTPS origin as a custom server during extension onboarding and grant that origin's access prompt. The extension refuses insecure non-loopback origins, credentials, URL paths, query strings and fragments.

For a distribution with an official server, supply build-time configuration:

```powershell
$env:RELAY_OFFICIAL_ORIGIN = 'https://your-worker-origin.workers.dev'
$env:RELAY_REPOSITORY_URL = 'https://github.com/your-owner/your-repository'
pnpm build
```

Those example values must be replaced with origins/repository URLs you control. The build grants the official host narrowly; it does not create an official service or deploy anything. `.env.example` is a reference; build configuration is read from environment variables, not automatically from a `.env` file.

## Operating considerations

Disable or minimize request logs, especially socket ticket query strings. Protect Cloudflare administrator access and backups. The application does not log decrypted content or secrets, but infrastructure may retain IP addresses and public handles. Set a real retention/deletion policy and security contact before accepting users.

Monitor cost and abuse without browsing analytics. Current per-IP/per-account rate limits are a baseline, not a guarantee against account-creation floods or distributed abuse. Configure Cloudflare billing alerts and evaluate stricter edge controls. Test recovery from backups; rollback protection intentionally rejects snapshots older than an existing client's known revision.

Server switching is locked after onboarding to prevent mixing identities/state. To use another server, create/recover an account in a separate browser profile. Account migration is not implemented. Do not point an active identity at an unrelated origin and assume state was moved.

Regenerate runtime types after configuration changes:

```sh
pnpm --filter @relay/server exec wrangler types src/worker-configuration.d.ts
```

The generated file is checked in for reproducible typechecking. Do not hand-edit it.
