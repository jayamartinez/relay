import { env } from "cloudflare:workers";
import {
  checkControl,
  controlHash,
  encryptEnvelope,
  ephemeral,
  hash,
  identity,
  makeControl,
  randomKey,
  recoverIdentity,
  sign,
  wrapRoot,
} from "@relay/crypto";
import {
  type Challenge,
  type Control,
  controlBody,
  parseOperation,
  type SyncReply,
} from "@relay/protocol";
import {
  canonical,
  LIMITS,
  SYNC_CLIENT_RESPONSE_BYTE_LIMIT,
  SYNC_RESPONSE_BYTE_BUDGET,
} from "@relay/shared";
import { describe, expect, it } from "vitest";
import { fixture } from "../../../tests/fixtures";

async function client() {
  const f = await fixture();
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(f.handle));
  const post = (action: string, payload: unknown, proof?: unknown) =>
    stub.fetch(`http://relay/v1/${f.handle}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, proof }),
    });
  expect((await post("create", { control: f.control, snapshot: f.snapshot })).status).toBe(200);
  const auth = async (
    action: string,
    payload: unknown,
    device = f.device.device.id,
    key = f.device.signing,
  ) => {
    const response = await post("challenge", {
      device,
      purpose: action,
      digest: await hash(canonical(payload)),
    });
    if (!response.ok) return response;
    const challenge = await response.json<Challenge>();
    return post(action, payload, { challenge, signature: await sign(key, challenge) });
  };
  return { ...f, stub, post, auth };
}
const responseBytes = async (response: Response) =>
  new TextEncoder().encode(await response.clone().text()).byteLength;

async function pushLargeOperation(
  f: Awaited<ReturnType<typeof client>>,
  sequence: number,
  base: number,
) {
  // These are valid Relay tab-navigate changes: encrypted payloads are opaque
  // to the server, but every individual envelope remains below the 2 MB request
  // limit. Six such accepted operations used to make one sync response exceed
  // the extension's 8 MB transport guard.
  const url = `https://example.test/${"x".repeat(30_000)}`;
  const operation = {
    id: `large-${sequence}`,
    sender: f.device.device.id,
    sequence,
    base,
    changes: Array.from({ length: 36 }, (_, index) => ({
      type: "tab-navigate" as const,
      id: `tab-${sequence}-${index}`,
      kind: "web" as const,
      url,
      source: f.device.device.id,
    })),
  };
  parseOperation(operation);
  const envelope = await encryptEnvelope(
    f.root,
    f.device.signing,
    {
      version: 1,
      account: f.handle,
      epoch: 1,
      sender: f.device.device.id,
      sequence,
      base,
      type: "operation",
    },
    operation,
  );
  const request = await f.auth("push", { envelope });
  expect(request.status).toBe(200);
  expect(
    new TextEncoder().encode(JSON.stringify({ payload: { envelope } })).byteLength,
  ).toBeLessThan(LIMITS.message);
}

async function syncPage(
  f: Awaited<ReturnType<typeof client>>,
  since: number,
): Promise<{ reply: SyncReply; bytes: number }> {
  const response = await f.auth("sync", { since, generation: 0, pagination: true });
  expect(response.status).toBe(200);
  const bytes = await responseBytes(response);
  return { reply: await response.json<SyncReply>(), bytes };
}
describe("SQLite Durable Object", () => {
  it.each([-60_000, 60_000])(
    "accepts pairing read/reveal clock skew %i while rejecting replay and tampering",
    async (skew) => {
      const f = await client();
      const joiner = await identity();
      const e = await ephemeral();
      const start = {
        id: crypto.randomUUID(),
        device: joiner.device,
        commitment: e.commitment,
        expires: Date.now() + 590_000 + skew,
      };
      expect(
        (
          await f.post("pair-start", {
            ...start,
            signature: await sign(joiner.signing, {
              version: 1,
              account: f.handle,
              type: "pair-start",
              ...start,
            }),
          })
        ).status,
      ).toBe(200);
      const offer = await ephemeral();
      expect(
        (await f.auth("pair-offer", { id: start.id, commitment: offer.commitment })).status,
      ).toBe(200);
      for (const action of ["pair-read", "pair-reveal"]) {
        const proof = {
          version: 1,
          account: f.handle,
          action,
          id: start.id,
          nonce: crypto.randomUUID(),
          expires: Date.now() + 25_000 + skew,
          ...(action === "pair-reveal" ? { reveal: e.reveal } : {}),
        };
        const payload = { ...proof, signature: await sign(joiner.signing, proof) };
        const tampered = await f.post(action, { ...payload, nonce: crypto.randomUUID() });
        expect(tampered.status).toBe(400);
        expect((await f.post(action, payload)).status).toBe(200);
        const replay = await f.post(action, payload);
        expect(replay.status).toBe(400);
        expect((await replay.json()).error.code).toBe("PAIR_PROOF_REPLAYED");
      }
      for (const skew of [-180_000, 180_000]) {
        const proof = {
          version: 1,
          account: f.handle,
          action: "pair-read",
          id: start.id,
          nonce: crypto.randomUUID(),
          expires: Date.now() + 25_000 + skew,
        };
        const response = await f.post("pair-read", {
          ...proof,
          signature: await sign(joiner.signing, proof),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("PAIR_PROOF_TIMESTAMP_INVALID");
      }
    },
  );
  it("rejects expired pairing and makes denial a terminal one-time transition", async () => {
    const f = await client();
    const joiner = await identity();
    const e = await ephemeral();
    const start = {
      id: crypto.randomUUID(),
      device: joiner.device,
      commitment: e.commitment,
      expires: Date.now() + 60_000,
    };
    const signed = async (value: typeof start) => ({
      ...value,
      signature: await sign(joiner.signing, {
        version: 1,
        account: f.handle,
        type: "pair-start",
        ...value,
      }),
    });
    expect(
      (await f.post("pair-start", await signed({ ...start, expires: Date.now() - 1 }))).status,
    ).toBe(400);
    const clockAhead = { ...start, id: crypto.randomUUID(), expires: Date.now() + 650_000 };
    expect((await f.post("pair-start", await signed(clockAhead))).status).toBe(200);
    const invalidSignature = await f.post("pair-start", { ...start, signature: "invalid" });
    expect(invalidSignature.status).toBe(400);
    expect((await invalidSignature.json()).error.code).toBe("PAIR_REQUEST_SIGNATURE_INVALID");
    expect((await f.post("pair-start", await signed(start))).status).toBe(200);
    expect((await f.auth("pair-deny", { id: start.id })).status).toBe(200);
    expect((await f.auth("pair-deny", { id: start.id })).status).toBe(400);
    expect((await f.auth("pair-offer", { id: start.id, commitment: e.commitment })).status).toBe(
      400,
    );
    expect((await f.post("pair-start", await signed(start))).status).toBe(400);
  });
  it("allows an exact create retry but rejects account replacement", async () => {
    const f = await client();
    expect((await f.post("create", { control: f.control, snapshot: f.snapshot })).status).toBe(200);
    const other = await fixture();
    expect(
      (await f.post("create", { control: other.control, snapshot: other.snapshot })).status,
    ).toBe(409);
  });
  it("does not authorize an account handle or unknown device", async () => {
    const f = await client();
    expect((await f.post("sync", { since: 0 })).status).toBe(400);
    expect(
      (await f.post("challenge", { device: "unknown", purpose: "sync", digest: "x" })).status,
    ).toBe(403);
  });
  it("consumes challenges once and binds payload digest and purpose", async () => {
    const f = await client();
    const payload = { since: 0, generation: 0, force: true };
    const challenge = await (
      await f.post("challenge", {
        device: f.device.device.id,
        purpose: "sync",
        digest: await hash(canonical(payload)),
      })
    ).json<Challenge>();
    const proof = { challenge, signature: await sign(f.device.signing, challenge) };
    expect((await f.post("sync", payload, proof)).status).toBe(200);
    expect((await f.post("sync", payload, proof)).status).toBe(400);
  });
  it("orders encrypted operations, deduplicates and checkpoints for an offline client", async () => {
    const f = await client();
    const operation = {
      id: "op",
      sender: f.device.device.id,
      sequence: 1,
      base: 0,
      changes: [{ type: "window-create", id: "w", order: 0 }],
    };
    const envelope = await encryptEnvelope(
      f.root,
      f.device.signing,
      {
        version: 1,
        account: f.handle,
        epoch: 1,
        sender: f.device.device.id,
        sequence: 1,
        base: 0,
        type: "operation",
      },
      operation,
    );
    expect((await f.auth("push", { envelope })).status).toBe(200);
    expect((await f.auth("push", { envelope })).status).toBe(200);
    const sync = await (await f.auth("sync", { since: 0, generation: 0 })).json<SyncReply>();
    expect(sync.revision).toBe(1);
    expect(sync.operations).toHaveLength(1);
    expect({ from: sync.from, next: sync.next, more: sync.more }).toEqual({
      from: 0,
      next: 1,
      more: false,
    });
    expect(sync.sequence).toBe(1);
    expect(JSON.stringify(sync.operations)).not.toContain("window-create");
    const snapshot = await encryptEnvelope(
      f.root,
      f.device.signing,
      { ...f.snapshot.header, base: 1 },
      { ...f.workspace, revision: 1, sequences: { [f.device.device.id]: 1 } },
    );
    expect((await f.auth("checkpoint", { snapshot })).status).toBe(200);
    const resumedResponse = await f.auth("sync", { since: 0, generation: 0, pagination: true });
    expect(await responseBytes(resumedResponse)).toBeLessThanOrEqual(SYNC_RESPONSE_BYTE_BUDGET);
    const resumed = await resumedResponse.json<SyncReply>();
    expect(resumed.snapshot?.header.base).toBe(1);
    expect(resumed.operations).toHaveLength(0);
    expect({ from: resumed.from, next: resumed.next, more: resumed.more }).toEqual({
      from: 1,
      next: 1,
      more: false,
    });
    expect((await f.auth("checkpoint", { snapshot: f.snapshot })).status).toBe(409);
  });
  it("bounds a legal oversized history into contiguous UTF-8-budgeted sync pages", async () => {
    const f = await client();
    for (let sequence = 1; sequence <= 6; sequence++)
      await pushLargeOperation(f, sequence, sequence - 1);

    const pages: SyncReply[] = [];
    let since = 0;
    do {
      const page = await syncPage(f, since);
      expect(page.bytes).toBeLessThanOrEqual(SYNC_RESPONSE_BYTE_BUDGET);
      expect(page.reply.from).toBe(since);
      expect(page.reply.next).toBeGreaterThanOrEqual(since);
      expect(page.reply.more).toBe(page.reply.next < page.reply.revision);
      pages.push(page.reply);
      since = page.reply.next;
    } while (pages.at(-1)!.more);

    expect(pages).toHaveLength(2);
    expect(pages[0]!.operations).toHaveLength(4);
    expect(new TextEncoder().encode(JSON.stringify(pages[0])).byteLength).toBeGreaterThan(
      5_000_000,
    );
    expect(pages[1]!.operations).toHaveLength(2);
    expect(pages.flatMap((page) => page.operations.map((operation) => operation.revision))).toEqual(
      [1, 2, 3, 4, 5, 6],
    );
    // This reconstructs the former one-response shape from envelopes actually
    // accepted and returned by the Durable Object; it demonstrates the real
    // server/client limit mismatch without mocking a response length.
    const legacyResponse = {
      ...pages[0],
      operations: pages.flatMap((page) => page.operations),
      next: 6,
      more: false,
    };
    expect(new TextEncoder().encode(JSON.stringify(legacyResponse)).byteLength).toBeGreaterThan(
      SYNC_CLIENT_RESPONSE_BYTE_LIMIT,
    );
  });
  it("transfers one large legal operation and rejects unsafe or malformed continuations", async () => {
    const f = await client();
    await pushLargeOperation(f, 1, 0);
    const page = await syncPage(f, 0);
    expect(page.reply.operations).toHaveLength(1);
    expect(page.reply.more).toBe(false);
    expect(page.bytes).toBeLessThanOrEqual(SYNC_RESPONSE_BYTE_BUDGET);
    expect((await f.auth("sync", { since: 2, generation: 0, pagination: true })).status).toBe(409);

    await pushLargeOperation(f, 2, 1);
    await pushLargeOperation(f, 3, 2);
    await pushLargeOperation(f, 4, 3);
    await pushLargeOperation(f, 5, 4);
    expect((await f.auth("sync", { since: 0, generation: 0 })).status).toBe(409);
  });
  it("continues from canonical revisions when an operation arrives between pages", async () => {
    const f = await client();
    for (let sequence = 1; sequence <= 5; sequence++)
      await pushLargeOperation(f, sequence, sequence - 1);
    const first = await syncPage(f, 0);
    expect(first.reply.more).toBe(true);
    await pushLargeOperation(f, 6, 5);
    const second = await syncPage(f, first.reply.next);
    expect(second.reply.from).toBe(first.reply.next);
    expect(second.reply.operations.map((operation) => operation.revision)).toEqual([5, 6]);
    expect(second.reply.next).toBe(6);
    expect(second.reply.more).toBe(false);
  });
  it("recovers authorization, rotates keys, and rejects revoked signers", async () => {
    const f = await client();
    const b = await identity();
    const recovery = await recoverIdentity(f.secret, f.handle, f.control.recovery);
    const add = await makeControl(
      {
        ...controlBody(f.control),
        generation: 1,
        previous: await controlHash(f.control),
        actor: "recovery",
        members: [f.device.device, b.device],
        boxes: {
          ...f.control.boxes,
          [b.device.id]: await wrapRoot(f.root, b.device.exchange, f.handle, 1, b.device.id),
        },
      },
      recovery.signing,
    );
    expect(
      (await f.auth("recover-join", { control: add }, "recovery", recovery.signing)).status,
    ).toBe(200);
    expect((await f.auth("sync", { since: 0, generation: 0 }, b.device.id, b.signing)).status).toBe(
      200,
    );
    const root = randomKey();
    const rotated: Control = await makeControl(
      {
        ...controlBody(add),
        generation: 2,
        previous: await controlHash(add),
        actor: f.device.device.id,
        epoch: 2,
        members: [f.device.device],
        boxes: {
          [f.device.device.id]: await wrapRoot(
            root,
            f.device.device.exchange,
            f.handle,
            2,
            f.device.device.id,
          ),
          recovery: await wrapRoot(root, add.recovery.exchange, f.handle, 2, "recovery"),
        },
      },
      f.device.signing,
    );
    await checkControl(rotated, add);
    const snapshot = await encryptEnvelope(
      root,
      f.device.signing,
      { ...f.snapshot.header, epoch: 2 },
      f.workspace,
    );
    expect((await f.auth("rotate", { control: rotated, snapshot })).status).toBe(200);
    expect((await f.auth("sync", { since: 0, generation: 1 }, b.device.id, b.signing)).status).toBe(
      403,
    );
    expect((await f.auth("checkpoint", { snapshot: f.snapshot })).status).toBe(400);
  });
  it("upgrades only a one-use authorized WebSocket ticket and auto-responds to heartbeat", async () => {
    const f = await client();
    const { ticket } = await (await f.auth("socket-ticket", {})).json<{ ticket: string }>();
    const response = await f.stub.fetch(`http://relay/v1/${f.handle}/socket?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const pong = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => {
        if (event.data === "pong") resolve(String(event.data));
      }),
    );
    socket.send("ping");
    expect(await pong).toBe("pong");
    expect(
      (
        await f.stub.fetch(`http://relay/v1/${f.handle}/socket?ticket=${ticket}`, {
          headers: { Upgrade: "websocket" },
        })
      ).status,
    ).toBe(403);
    socket.close();
  });
});
