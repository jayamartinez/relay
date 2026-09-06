// SPDX-License-Identifier: AGPL-3.0-or-later
import { DurableObject } from "cloudflare:workers";
import { checkControl, hash, verify } from "@relay/crypto";
import {
  CHALLENGE_LIFETIME_MS,
  type Challenge,
  CLOCK_SKEW_MS,
  type Control,
  type Envelope,
  type OperationRow,
  type PairRequest,
  type PairStart,
  type Proof,
  parseControl,
  parseDevice,
  parseEnvelope,
  type Reveal,
  sameDevice,
} from "@relay/protocol";
import {
  assert,
  canonical,
  id,
  integer,
  LIMITS,
  record,
  SYNC_RESPONSE_BYTE_BUDGET,
  text,
} from "@relay/shared";

interface Env {
  ACCOUNTS: DurableObjectNamespace<RelayAccount>;
  EDGE_LIMIT: RateLimit;
  ENROLL_LIMIT: RateLimit;
  // Optional lower test/staging budget. It can never raise the production
  // contract above the shared safe default.
  SYNC_RESPONSE_BYTE_BUDGET?: string;
}
interface Meta {
  control: Control;
  snapshot: Envelope;
  revision: number;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "REQUEST_VALIDATION_FAILED",
  ) {
    super(message);
  }
}
function fail(status: number, message: string, code?: string): never {
  throw new HttpError(status, message, code);
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ name: "Relay", protocolVersion: 1 });
    const match = /^\/v1\/([a-f0-9]{64})\/([a-z-]+)$/.exec(url.pathname);
    if (!match) return json({ error: "Not found" }, 404);
    const address = request.headers.get("CF-Connecting-IP") ?? "local";
    if (
      ["create", "pair-start", "recover-info"].includes(match[2] ?? "") &&
      !(await env.ENROLL_LIMIT.limit({ key: address })).success
    )
      return json({ error: "Too many enrollment attempts." }, 429);
    if (!(await env.EDGE_LIMIT.limit({ key: address })).success)
      return json({ error: "Too many requests. Try again later." }, 429);
    const handle = match[1];
    assert(handle);
    return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(handle)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class RelayAccount extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS operations (revision INTEGER PRIMARY KEY, envelope TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS controls (generation INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS transient (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)",
    );
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  private get<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private syncResponseBudget() {
    if (this.env.SYNC_RESPONSE_BYTE_BUDGET === undefined) return SYNC_RESPONSE_BYTE_BUDGET;
    const configured = Number(this.env.SYNC_RESPONSE_BYTE_BUDGET);
    assert(
      Number.isSafeInteger(configured) && configured > 0 && configured <= SYNC_RESPONSE_BYTE_BUDGET,
      "Invalid sync response budget.",
    );
    return configured;
  }
  private put(key: string, value: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO state(key,value) VALUES (?,?)",
      key,
      JSON.stringify(value),
    );
  }
  private temporary(key: string, value: unknown, expires: number) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO transient(key,value,expires) VALUES (?,?,?)",
      key,
      JSON.stringify(value),
      expires,
    );
  }
  private readTemporary<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM transient WHERE key = ? AND expires > ?",
        key,
        Date.now(),
      )
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private removeTemporary(key: string) {
    this.ctx.storage.sql.exec("DELETE FROM transient WHERE key = ?", key);
  }
  private meta(): Meta {
    return this.get<Meta>("meta") ?? fail(404, "Account not found.");
  }
  private budget(kind: string, limit: number) {
    const bucket = `rate:${kind}`;
    const old = this.get<{ start: number; count: number }>(bucket);
    const current = old && old.start + 60_000 > Date.now() ? old : { start: Date.now(), count: 0 };
    if (++current.count > limit) fail(429, "Too many attempts. Wait a minute.");
    this.put(bucket, current);
  }
  private pending(): PairRequest[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM transient WHERE key LIKE 'pair:%' AND expires > ?",
        Date.now(),
      )
      .toArray()
      .map((row) => JSON.parse(row.value) as PairRequest);
  }
  private pair(requestId: unknown): PairRequest {
    return (
      this.readTemporary<PairRequest>(`pair:${id(requestId)}`) ??
      fail(410, "Approval expired. Start again.")
    );
  }
  private savePair(pair: PairRequest) {
    this.temporary(`pair:${pair.id}`, pair, pair.expires);
    this.broadcast();
  }
  private broadcast() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send("changed");
      } catch {
        ws.close(1011, "Reconnect");
      }
    }
  }
  private async authenticate(
    account: string,
    purpose: string,
    payload: unknown,
    raw: unknown,
  ): Promise<string> {
    const p = record(raw) as unknown as Proof;
    const c = record(p.challenge) as unknown as Challenge;
    const nonce = id(c.nonce);
    const stored = this.readTemporary<Challenge>(`challenge:${nonce}`);
    assert(stored && canonical(c) === canonical(stored), "Expired authentication challenge.");
    this.removeTemporary(`challenge:${nonce}`);
    assert(
      c.version === 1 &&
        c.account === account &&
        c.purpose === purpose &&
        c.expires > Date.now() &&
        c.digest === (await hash(canonical(payload))),
      "Authentication context mismatch.",
    );
    const meta = this.meta();
    const key =
      c.device === "recovery" && purpose === "recover-join"
        ? meta.control.recovery.auth
        : meta.control.members.find((d) => d.id === c.device)?.auth;
    if (!key) fail(403, "Device is not authorized.");
    if (!(await verify(key, c, p.signature))) fail(403, "Authentication failed.");
    if (c.device !== "recovery") this.put(`seen:${c.device}`, Date.now());
    return c.device;
  }
  private async verifyEnvelope(
    envelope: Envelope,
    account: string,
    meta: Meta,
    actor: string,
    type: "snapshot" | "operation",
  ) {
    const h = envelope.header;
    assert(
      h.account === account &&
        h.epoch === meta.control.epoch &&
        h.sender === actor &&
        h.type === type,
    );
    const member = meta.control.members.find((d) => d.id === actor);
    assert(
      member &&
        (await verify(member.auth, { header: h, cipher: envelope.cipher }, envelope.signature)),
    );
  }
  private commitControl(control: Control) {
    this.ctx.storage.sql.exec(
      "INSERT INTO controls(generation,value) VALUES (?,?)",
      control.generation,
      JSON.stringify(control),
    );
  }
  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        this.ctx.storage.sql.exec("DELETE FROM transient WHERE expires <= ?", Date.now());
        const url = new URL(request.url);
        const parts = url.pathname.split("/");
        const account = parts[2];
        const action = parts[3];
        assert(account && action);
        if (action === "socket") return this.socket(url, request);
        if (request.method !== "POST") return json({ error: "POST required" }, 405);
        const length = Number(request.headers.get("Content-Length") ?? "0");
        if (length > LIMITS.message) fail(413, "Request too large.");
        // Read through a bounded stream, including requests without Content-Length.
        const reader = request.body?.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        if (reader)
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > LIMITS.message) {
              await reader.cancel();
              fail(413, "Request too large.");
            }
            chunks.push(part.value);
          }
        const bodyBytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bodyBytes.set(chunk, offset);
          offset += chunk.length;
        }
        const input = record(JSON.parse(new TextDecoder().decode(bodyBytes)));
        const payload = record(input.payload ?? {});
        this.budget("all", 1200);
        return await this.dispatch(account, action, payload, input.proof);
      } catch (error) {
        return json(
          {
            error:
              error instanceof HttpError
                ? { code: error.code, message: error.message }
                : { code: "REQUEST_VALIDATION_FAILED", message: "Request validation failed." },
          },
          error instanceof HttpError ? error.status : 400,
        );
      }
    });
  }
  private async dispatch(
    account: string,
    action: string,
    p: Record<string, unknown>,
    proof: unknown,
  ): Promise<Response> {
    if (action === "create") {
      this.budget("create", 3);
      const existing = this.get<Meta>("meta");
      if (existing) {
        if (
          canonical(existing.control) === canonical(p.control) &&
          canonical(existing.snapshot) === canonical(p.snapshot)
        )
          return json({ ok: true });
        fail(409, "Account already exists.");
      }
      const control = parseControl(p.control);
      assert(control.account === account);
      await checkControl(control);
      const snapshot = parseEnvelope(p.snapshot);
      const meta = { control, snapshot, revision: 0 };
      await this.verifyEnvelope(snapshot, account, meta, control.actor, "snapshot");
      assert(snapshot.header.base === 0);
      this.ctx.storage.transactionSync(() => {
        this.put("meta", meta);
        this.commitControl(control);
      });
      return json({ ok: true });
    }
    if (action === "challenge") {
      this.budget("challenge", 600);
      const meta = this.meta();
      const device = id(p.device);
      const purpose = text(p.purpose, 40);
      if (
        !meta.control.members.some((d) => d.id === device) &&
        !(device === "recovery" && purpose === "recover-join")
      )
        fail(403, "Device is not authorized.");
      const issued = Date.now();
      const challenge: Challenge = {
        version: 1,
        account,
        device,
        purpose,
        nonce: crypto.randomUUID(),
        issued,
        expires: issued + CHALLENGE_LIFETIME_MS,
        digest: text(p.digest, 64),
      };
      this.temporary(`challenge:${challenge.nonce}`, challenge, challenge.expires);
      return json(challenge);
    }
    if (action === "recover-info") {
      this.budget("recovery", 6);
      const m = this.meta();
      return json({ recovery: m.control.recovery, chain: this.chain(-1) });
    }
    if (action === "pair-start") {
      this.budget("enrollment", 5);
      this.meta();
      if (this.pending().filter((r) => r.status === "pending").length >= LIMITS.pending)
        fail(429, "Too many pending requests.");
      let start: PairStart;
      let signature: string;
      try {
        start = {
          id: id(p.id),
          device: parseDevice(p.device),
          commitment: text(p.commitment, 64),
          expires: integer(p.expires),
        };
        signature = text(p.signature, 256);
      } catch {
        fail(400, "Relay could not validate this device request.", "PAIR_REQUEST_SCHEMA_INVALID");
      }
      if (
        start!.expires <= Date.now() ||
        start!.expires > Date.now() + 600_000 + CLOCK_SKEW_MS ||
        start!.device.id === "recovery"
      )
        fail(
          400,
          "The request timestamp is invalid. Check your system clock.",
          "PAIR_REQUEST_TIMESTAMP_INVALID",
        );
      if (
        this.readTemporary(`pair:${start!.id}`) ||
        this.meta().control.members.some((d) => d.id === start!.device.id)
      )
        fail(400, "This device request already exists.", "PAIR_REQUEST_ALREADY_EXISTS");
      if (
        !(await verify(
          start!.device.auth,
          { version: 1, account, type: "pair-start", ...start! },
          signature!,
        ))
      )
        fail(400, "Relay could not verify this device request.", "PAIR_REQUEST_SIGNATURE_INVALID");
      this.savePair({ ...start!, status: "pending" });
      return json({ ok: true });
    }
    if (action === "pair-read" || action === "pair-reveal") {
      this.budget("pair-read", 40);
      const pair = this.pair(p.id);
      const nonce = text(p.nonce, 64);
      const expires = integer(p.expires);
      const now = Date.now();
      if (expires <= now - CLOCK_SKEW_MS || expires > now + CHALLENGE_LIFETIME_MS + CLOCK_SKEW_MS)
        fail(
          400,
          "The pairing proof timestamp is invalid. Check your system clock.",
          "PAIR_PROOF_TIMESTAMP_INVALID",
        );
      if (this.readTemporary(`pair-proof:${nonce}`))
        fail(400, "This pairing proof was already used.", "PAIR_PROOF_REPLAYED");
      const signed = {
        version: 1,
        account,
        action,
        id: pair.id,
        nonce,
        expires,
        ...(action === "pair-reveal" ? { reveal: p.reveal } : {}),
      };
      if (!(await verify(pair.device.auth, signed, text(p.signature, 256))))
        fail(400, "Relay could not verify this pairing proof.", "PAIR_PROOF_SIGNATURE_INVALID");
      // Retain the nonce through the entire skew-adjusted acceptance window.
      // Storing only until expires would let a slow clock replay its proof.
      this.temporary(`pair-proof:${nonce}`, true, expires + CLOCK_SKEW_MS);
      if (action === "pair-reveal") {
        assert(pair.status === "pending" && pair.offer && !pair.requesterReveal);
        const reveal = this.reveal(p.reveal);
        assert((await hash(canonical(reveal))) === pair.commitment);
        pair.requesterReveal = reveal;
        this.savePair(pair);
      }
      return json(pair);
    }
    const actor = await this.authenticate(account, action, p, proof);
    const meta = this.meta();
    if (action === "sync") {
      const since = integer(p.since);
      const generation = Number(p.generation);
      assert(Number.isInteger(generation) && generation >= -1);
      if (since > meta.revision) fail(409, "Sync continuation is ahead of the server.");
      const pagination = p.pagination === true;
      const responseBudget = this.syncResponseBudget();
      const controls = this.controlPage(generation, meta.control.generation);
      if (controls.chain.length) {
        // Control entries authenticate membership and root provisioning. A
        // pagination-capable client validates/persists these pages before it is
        // ever sent workspace ciphertext for the resulting epoch.
        if (pagination) return json(controls);
        if (controls.more)
          fail(409, "Update Relay to continue this bounded sync.", "SYNC_PAGINATION_REQUIRED");
      }
      const snapshot =
        since < meta.snapshot.header.base || p.force === true ? meta.snapshot : undefined;
      const from = snapshot ? snapshot.header.base : since;
      const presence: Record<string, { online: boolean; lastSeen: number }> = {};
      for (const device of meta.control.members)
        presence[device.id] = {
          online: this.ctx.getWebSockets(device.id).length > 0,
          lastSeen: this.get<number>(`seen:${device.id}`) ?? 0,
        };
      const reply = {
        ...(pagination
          ? { kind: "workspace" as const, generation: meta.control.generation, chain: [] }
          : { control: meta.control, chain: controls.chain }),
        snapshot,
        revision: meta.revision,
        sequence: this.get<number>(`seq:${actor}`) ?? 0,
        pending: this.pending().filter((r) => r.status === "pending"),
        presence,
        from,
      };
      // Use maximum-width continuation values while accounting. This is a
      // conservative, UTF-8-exact budget for the final JSON without repeatedly
      // serializing a growing response body.
      const emptyPageBytes = jsonBytes({
        ...reply,
        operations: [],
        next: Number.MAX_SAFE_INTEGER,
        more: false,
      });
      if (emptyPageBytes > responseBudget) {
        if (!pagination)
          fail(409, "Update Relay to continue this bounded sync.", "SYNC_PAGINATION_REQUIRED");
        fail(413, "Sync metadata exceeds the response budget.", "SYNC_RESPONSE_TOO_LARGE");
      }
      const operations: OperationRow[] = [];
      let operationBytes = 0;
      for (const row of this.ctx.storage.sql.exec<{ revision: number; envelope: string }>(
        "SELECT revision,envelope FROM operations WHERE revision > ? ORDER BY revision",
        from,
      )) {
        const operation = { revision: row.revision, envelope: JSON.parse(row.envelope) };
        const serializedBytes = jsonBytes(operation);
        const delimiterBytes = operations.length ? 1 : 0;
        if (emptyPageBytes + operationBytes + delimiterBytes + serializedBytes > responseBudget) {
          if (!operations.length)
            fail(
              413,
              "One operation exceeds the sync response budget.",
              "SYNC_OPERATION_TOO_LARGE",
            );
          break;
        }
        operationBytes += delimiterBytes + serializedBytes;
        operations.push(operation);
      }
      const next = operations.at(-1)?.revision ?? from;
      const more = next < meta.revision;
      // Older v1 clients do not understand a partial reply and would reject it
      // after receiving it. Refuse safely instead of sending an oversized body.
      if (more && !pagination)
        fail(409, "Update Relay to continue this bounded sync.", "SYNC_PAGINATION_REQUIRED");
      const page = { ...reply, operations, next, more };
      // The conservative estimate above should make this unreachable; retain an
      // exact final assertion against future response-shape changes.
      if (jsonBytes(page) > responseBudget)
        fail(413, "Sync response exceeds the response budget.", "SYNC_RESPONSE_TOO_LARGE");
      return json(page);
    }
    if (action === "socket-ticket") {
      const ticket = crypto.randomUUID();
      this.temporary(`ticket:${ticket}`, actor, Date.now() + 30_000);
      return json({ ticket });
    }
    if (action === "push") {
      const envelope = parseEnvelope(p.envelope);
      await this.verifyEnvelope(envelope, account, meta, actor, "operation");
      const previous = this.get<number>(`seq:${actor}`) ?? 0;
      if (envelope.header.sequence <= previous)
        return json({ duplicate: true, revision: meta.revision });
      assert(envelope.header.sequence === previous + 1 && envelope.header.base <= meta.revision);
      if (meta.revision - meta.snapshot.header.base >= LIMITS.operations)
        fail(409, "Checkpoint required.");
      meta.revision++;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO operations(revision,envelope) VALUES (?,?)",
          meta.revision,
          JSON.stringify(envelope),
        );
        this.put(`seq:${actor}`, envelope.header.sequence);
        this.put("meta", meta);
      });
      this.broadcast();
      return json({ revision: meta.revision });
    }
    if (action === "checkpoint") {
      const snapshot = parseEnvelope(p.snapshot);
      await this.verifyEnvelope(snapshot, account, meta, actor, "snapshot");
      if (snapshot.header.base !== meta.revision) fail(409, "Workspace changed. Retry checkpoint.");
      meta.snapshot = snapshot;
      this.ctx.storage.transactionSync(() => {
        this.put("meta", meta);
        this.ctx.storage.sql.exec("DELETE FROM operations WHERE revision <= ?", meta.revision);
      });
      return json({ ok: true });
    }
    if (action === "pair-offer") {
      const pair = this.pair(p.id);
      assert(pair.status === "pending" && !pair.offer);
      const device = meta.control.members.find((d) => d.id === actor);
      assert(device);
      pair.offer = { device, commitment: text(p.commitment, 64) };
      this.savePair(pair);
      return json(pair);
    }
    if (action === "pair-answer") {
      const pair = this.pair(p.id);
      assert(
        pair.status === "pending" &&
          pair.offer?.device.id === actor &&
          pair.requesterReveal &&
          !pair.approverReveal,
      );
      const reveal = this.reveal(p.reveal);
      assert((await hash(canonical(reveal))) === pair.offer.commitment);
      pair.approverReveal = reveal;
      this.savePair(pair);
      return json(pair);
    }
    if (action === "pair-deny") {
      const pair = this.pair(p.id);
      assert(pair.status === "pending");
      pair.status = "denied";
      this.savePair(pair);
      return json({ ok: true });
    }
    if (action === "pair-approve" || action === "recover-join" || action === "rotate") {
      const control = parseControl(p.control);
      assert(control.actor === actor);
      if (control.generation !== meta.control.generation + 1)
        fail(409, "Membership changed. Refresh and try again.");
      assert(control.generation < LIMITS.control, "Account membership history limit reached.");
      await checkControl(control, meta.control);
      const added = control.members.find(
        (d) => !meta.control.members.some((old) => old.id === d.id),
      );
      let pair: PairRequest | undefined;
      if (action === "pair-approve") {
        pair = this.pair(p.id);
        assert(
          pair.status === "pending" &&
            pair.offer?.device.id === actor &&
            pair.requesterReveal &&
            pair.approverReveal &&
            added &&
            sameDevice(added, pair.device),
        );
      } else if (action === "recover-join") {
        assert(actor === "recovery" && added);
      } else {
        assert(!added && control.epoch === meta.control.epoch + 1);
      }
      if (action === "rotate") {
        const snapshot = parseEnvelope(p.snapshot);
        await this.verifyEnvelope(snapshot, account, { ...meta, control }, actor, "snapshot");
        if (snapshot.header.base !== meta.revision)
          fail(409, "Workspace changed. Retry revocation.");
        meta.snapshot = snapshot;
      }
      const revoked = meta.control.members.filter(
        (d) => !control.members.some((n) => n.id === d.id),
      );
      meta.control = control;
      this.ctx.storage.transactionSync(() => {
        this.commitControl(control);
        this.put("meta", meta);
        if (action === "rotate") this.ctx.storage.sql.exec("DELETE FROM operations");
        if (pair) {
          pair.status = "approved";
          pair.control = control;
          this.temporary(`pair:${pair.id}`, pair, pair.expires);
        }
      });
      for (const device of revoked)
        for (const ws of this.ctx.getWebSockets(device.id)) {
          ws.send(JSON.stringify({ type: "revoked", chain: this.chain(-1) }));
          ws.close(4003, "Revoked");
        }
      this.broadcast();
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }
  private reveal(raw: unknown): Reveal {
    const r = record(raw);
    return { ephemeral: text(r.ephemeral, 256), random: text(r.random, 64) };
  }
  private chain(after: number): Control[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM controls WHERE generation > ? ORDER BY generation",
        after,
      )
      .toArray()
      .map((row) => JSON.parse(row.value) as Control);
  }
  private controlPage(fromGeneration: number, currentGeneration: number) {
    const responseBudget = this.syncResponseBudget();
    const base = {
      kind: "control" as const,
      chain: [],
      fromGeneration,
      nextGeneration: Number.MAX_SAFE_INTEGER,
      more: false,
    };
    const emptyPageBytes = jsonBytes(base);
    if (emptyPageBytes > responseBudget)
      fail(413, "Sync control metadata exceeds the response budget.", "SYNC_RESPONSE_TOO_LARGE");
    const chain: Control[] = [];
    let chainBytes = 0;
    for (const row of this.ctx.storage.sql.exec<{ generation: number; value: string }>(
      "SELECT generation,value FROM controls WHERE generation > ? ORDER BY generation",
      fromGeneration,
    )) {
      const control = JSON.parse(row.value) as Control;
      const serializedBytes = jsonBytes(control);
      const delimiterBytes = chain.length ? 1 : 0;
      if (emptyPageBytes + chainBytes + delimiterBytes + serializedBytes > responseBudget) {
        if (!chain.length)
          fail(
            413,
            "One control entry exceeds the sync response budget.",
            "SYNC_CONTROL_TOO_LARGE",
          );
        break;
      }
      chainBytes += delimiterBytes + serializedBytes;
      chain.push(control);
    }
    const nextGeneration = chain.at(-1)?.generation ?? fromGeneration;
    const more = nextGeneration < currentGeneration;
    const page = { kind: "control" as const, chain, fromGeneration, nextGeneration, more };
    if (jsonBytes(page) > responseBudget)
      fail(413, "Sync control response exceeds the response budget.", "SYNC_RESPONSE_TOO_LARGE");
    return page;
  }
  private socket(url: URL, request: Request): Response {
    assert(request.headers.get("Upgrade")?.toLowerCase() === "websocket");
    const ticket = id(url.searchParams.get("ticket"));
    const device = this.readTemporary<string>(`ticket:${ticket}`);
    this.removeTemporary(`ticket:${ticket}`);
    if (!device || !this.meta().control.members.some((d) => d.id === device))
      fail(403, "Device is not authorized.");
    for (const old of this.ctx.getWebSockets(device)) old.close(1000, "Replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [device]);
    pair[1].serializeAttachment({ device });
    this.put(`seen:${device}`, Date.now());
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer) {
    ws.close(1008, "Only heartbeat messages are accepted.");
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    const attachment = ws.deserializeAttachment() as { device?: string } | null;
    if (attachment?.device) this.put(`seen:${attachment.device}`, Date.now());
    ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    this.broadcast();
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Reconnect");
  }
}
