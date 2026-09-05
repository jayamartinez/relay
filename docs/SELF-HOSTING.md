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

## Hosted Relay environments

You need a Cloudflare account with Workers/Durable Objects access and suitable plan/limits. Confirm current [Cloudflare requirements](https://developers.cloudflare.com/durable-objects/platform/pricing/) before deployment. `apps/server/wrangler.jsonc` defines `ACCOUNTS`, SQLite migration `v1`, and edge rate-limit bindings. Initial deployment runs the migration for the exported `RelayAccount` class.

The checked-in Wrangler configuration keeps hosted environments separate:

- Production: `relay` at `https://relay.relay-sync.workers.dev`, rate-limit namespaces `1001` and `1002`.
- Staging: `relay-staging` at `https://relay-staging.relay-sync.workers.dev`, rate-limit namespaces `1101` and `1102`.

Each environment receives its own SQLite-backed `RelayAccount` Durable Object namespace. Deploy them explicitly:

```sh
pnpm --filter @relay/server exec wrangler login
pnpm --filter @relay/server deploy:staging
pnpm --filter @relay/server deploy:production
```

No root/recovery/device secrets belong in Worker variables. TLS must terminate at a trusted endpoint. Use the returned HTTPS origin as a custom server during extension onboarding and grant that origin's access prompt. The extension refuses insecure non-loopback origins, credentials, URL paths, query strings and fragments.

Production extension builds automatically use the official production origin. Development builds default to local Wrangler, and the staging build targets only the staging Worker:

```sh
pnpm build:extension:dev
pnpm build:extension:staging
pnpm build:extension:production
```

Self-hosted distributions can still override the build-time origin and repository link:

```powershell
$env:RELAY_OFFICIAL_ORIGIN = 'https://your-worker-origin.workers.dev'
$env:RELAY_REPOSITORY_URL = 'https://github.com/your-owner/your-repository'
pnpm build
```

Those example values must be replaced with origins/repository URLs you control. The build grants the selected host narrowly and never deploys it. `.env.example` is a reference; build configuration is read from environment variables, not automatically from a `.env` file.

## Operating considerations

Invocation logs and traces are disabled in Wrangler observability so normal hosted telemetry does not persist IP, location, or request metadata. Sanitized intentional application logs may be retained, but the current Worker emits none. Cloudflare still processes IP addresses for networking and edge rate limiting. Protect Cloudflare administrator access and backups, and set a real retention/deletion policy and security contact before accepting users.

Monitor cost and abuse without browsing analytics. Current per-IP/per-account rate limits are a baseline, not a guarantee against account-creation floods or distributed abuse. Configure Cloudflare billing alerts and evaluate stricter edge controls. Test recovery from backups; rollback protection intentionally rejects snapshots older than an existing client's known revision.

Server switching is locked after onboarding to prevent mixing identities/state. To use another server, create/recover an account in a separate browser profile. Account migration is not implemented. Do not point an active identity at an unrelated origin and assume state was moved.

Regenerate runtime types after configuration changes:

```sh
pnpm --filter @relay/server exec wrangler types src/worker-configuration.d.ts
```

The generated file is checked in for reproducible typechecking. Do not hand-edit it.
