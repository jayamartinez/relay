import { env } from "cloudflare:workers";
import {
  checkControl,
  controlHash,
  derive,
  encryptEnvelope,
  ephemeral,
  hash,
  identity,
  makeControl,
  open,
  randomKey,
  recoverIdentity,
  seal,
  sign,
  wrapRoot,
} from "@relay/crypto";
import {
  type Challenge,
  type Control,
  controlBody,
  parseOperation,
  type Recovery,
  type SyncReply,
} from "@relay/protocol";
import {
  canonical,
  LIMITS,
  SYNC_CLIENT_RESPONSE_BYTE_LIMIT,
  SYNC_RESPONSE_BYTE_BUDGET,
} from "@relay/shared";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "../../../tests/fixtures";

async function client(setup?: Awaited<ReturnType<typeof fixture>>) {
  const f = setup ?? (await fixture());
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
  it("rejects malformed and future membership cursors before returning workspace state", async () => {
    const f = await client();
    for (const generation of ["0", null, true, -2, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect((await f.auth("sync", { since: 0, generation, pagination: true })).status).toBe(400);
    expect((await f.auth("sync", { since: 0, generation: 1, pagination: true })).status).toBe(409);
    expect((await f.auth("sync", { since: 0, generation: -1, pagination: true })).status).toBe(200);
  });
  it("rejects a streamed oversized request without altering account state", async () => {
    const f = await client();
    const response = await f.stub.fetch(`http://relay/v1/${f.handle}/checkpoint`, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(LIMITS.message + 1));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(413);
    const sync = await (
      await f.auth("sync", { since: 0, generation: 0, force: true })
    ).json<SyncReply>();
    expect(sync.snapshot).toEqual(f.snapshot);
    expect(sync.revision).toBe(0);
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
    const freshProof = async () => {
      const challenge = await (
        await f.post("challenge", {
          device: f.device.device.id,
          purpose: "sync",
          digest: await hash(canonical(payload)),
        })
      ).json<Challenge>();
      return { challenge, signature: await sign(f.device.signing, challenge) };
    };
    const invalid = await freshProof();
    expect((await f.post("sync", payload, { ...invalid, signature: "invalid" })).status).toBe(403);
    expect((await f.post("sync", payload, invalid)).status).toBe(400);
    const changed = await freshProof();
    expect((await f.post("sync", { ...payload, force: false }, changed)).status).toBe(400);
    expect((await f.post("sync", payload, changed)).status).toBe(400);
    expect((await f.post("socket-ticket", payload, await freshProof())).status).toBe(400);
    const racing = await freshProof();
    const results = await Promise.all([
      f.post("sync", payload, racing),
      f.post("sync", payload, racing),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  });
  it("serves authenticated sync while another request body is unfinished", async () => {
    const f = await client();
    const { readable, writable } = new TransformStream<Uint8Array>();
    const writer = writable.getWriter();
    const slow = f.stub.fetch(`http://relay/v1/${f.handle}/challenge`, {
      method: "POST",
      body: readable,
    });
    await writer.write(new TextEncoder().encode('{"payload":'));
    const fast = f.auth("sync", { since: 0, generation: 0 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([
        fast.then((response) => response.status),
        new Promise<number>((resolve) => {
          timer = setTimeout(() => resolve(-1), 500);
        }),
      ]);
      expect(status).toBe(200);
    } finally {
      clearTimeout(timer);
      await writer.write(new TextEncoder().encode("{}}"));
      await writer.close();
      await slow;
      await fast;
    }
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
  it("pages a legal signed control chain before returning workspace state", async () => {
    const f = await client();
    const joining = await identity();
    const recovery = await recoverIdentity(f.secret, f.handle, f.control.recovery);
    const added = await makeControl(
      {
        ...controlBody(f.control),
        generation: 1,
        previous: await controlHash(f.control),
        actor: "recovery",
        members: [f.device.device, joining.device],
        boxes: {
          ...f.control.boxes,
          [joining.device.id]: await wrapRoot(
            f.root,
            joining.device.exchange,
            f.handle,
            1,
            joining.device.id,
          ),
        },
      },
      recovery.signing,
    );
    expect(
      (await f.auth("recover-join", { control: added }, "recovery", recovery.signing)).status,
    ).toBe(200);
    const rotatedRoot = randomKey();
    const rotated = await makeControl(
      {
        ...controlBody(added),
        generation: 2,
        previous: await controlHash(added),
        actor: f.device.device.id,
        epoch: 2,
        members: [f.device.device],
        boxes: {
          [f.device.device.id]: await wrapRoot(
            rotatedRoot,
            f.device.device.exchange,
            f.handle,
            2,
            f.device.device.id,
          ),
          recovery: await wrapRoot(rotatedRoot, added.recovery.exchange, f.handle, 2, "recovery"),
        },
      },
      f.device.signing,
    );
    const snapshot = await encryptEnvelope(
      rotatedRoot,
      f.device.signing,
      { ...f.snapshot.header, epoch: 2 },
      f.workspace,
    );
    const controlBytes = Math.max(
      new TextEncoder().encode(JSON.stringify(added)).byteLength,
      new TextEncoder().encode(JSON.stringify(rotated)).byteLength,
    );
    const { ticket } = await (
      await f.auth("socket-ticket", {}, joining.device.id, joining.signing)
    ).json<{ ticket: string }>();
    const opened = await f.stub.fetch(`http://relay/v1/${f.handle}/socket?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(opened.status).toBe(101);
    const socket = opened.webSocket!;
    socket.accept();
    const revokedFrames: string[] = [];
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data.startsWith('{"type":"revoked"'))
        revokedFrames.push(event.data);
    });
    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true }),
    );
    const testEnv = env as unknown as { SYNC_RESPONSE_BYTE_BUDGET?: string };
    testEnv.SYNC_RESPONSE_BYTE_BUDGET = String(controlBytes + 400);
    try {
      expect((await f.auth("rotate", { control: rotated, snapshot })).status).toBe(200);
      await closed;
      expect(revokedFrames).toHaveLength(3);
      expect(
        revokedFrames.every(
          (frame) => new TextEncoder().encode(frame).byteLength <= controlBytes + 400,
        ),
      ).toBe(true);
      expect(
        revokedFrames.flatMap((frame) => (JSON.parse(frame) as { chain: Control[] }).chain),
      ).toEqual([f.control, added, rotated]);
      expect((await f.auth("sync", { since: 0, generation: 0 })).status).toBe(409);
      const firstResponse = await f.auth("sync", { since: 0, generation: 0, pagination: true });
      const firstBytes = await responseBytes(firstResponse);
      const first = await firstResponse.json<SyncReply>();
      expect(firstResponse.status).toBe(200);
      expect(first.kind).toBe("control");
      expect(first.chain).toHaveLength(1);
      expect(first.fromGeneration).toBe(0);
      expect(first.nextGeneration).toBe(1);
      expect(first.more).toBe(true);
      expect(firstBytes).toBeLessThanOrEqual(controlBytes + 400);

      const secondResponse = await f.auth("sync", { since: 0, generation: 1, pagination: true });
      const secondBytes = await responseBytes(secondResponse);
      const second = await secondResponse.json<SyncReply>();
      expect(secondResponse.status).toBe(200);
      expect(second.kind).toBe("control");
      expect(second.chain).toHaveLength(1);
      expect(second.fromGeneration).toBe(1);
      expect(second.nextGeneration).toBe(2);
      expect(second.more).toBe(false);
      expect(secondBytes).toBeLessThanOrEqual(controlBytes + 400);

      delete testEnv.SYNC_RESPONSE_BYTE_BUDGET;
      const workspaceResponse = await f.auth("sync", {
        since: 0,
        generation: 2,
        pagination: true,
        force: true,
      });
      const workspace = await workspaceResponse.json<SyncReply>();
      expect(workspaceResponse.status).toBe(200);
      expect(workspace.kind).toBe("workspace");
      expect(workspace.generation).toBe(2);
      expect(workspace.snapshot?.header.epoch).toBe(2);

      const recoveryBytes = new TextEncoder().encode(JSON.stringify(f.control.recovery)).byteLength;
      const recoveryBudget = controlBytes + recoveryBytes + 300;
      testEnv.SYNC_RESPONSE_BYTE_BUDGET = String(recoveryBudget);
      const legacyRecovery = await f.post("recover-info", {});
      expect(legacyRecovery.status).toBe(409);
      expect((await legacyRecovery.json()).error.code).toBe("RECOVERY_PAGINATION_REQUIRED");
      const recoveryResponse = await f.post("recover-info", { pagination: true });
      expect(recoveryResponse.status).toBe(200);
      expect(await responseBytes(recoveryResponse)).toBeLessThanOrEqual(recoveryBudget);
      const recoveryPage = await recoveryResponse.json<SyncReply & { recovery: Recovery }>();
      expect(recoveryPage.recovery).toEqual(f.control.recovery);
      expect(recoveryPage.kind).toBe("control");
      expect(recoveryPage.fromGeneration).toBe(-1);
      expect(recoveryPage.nextGeneration).toBe(0);
      expect(recoveryPage.more).toBe(true);
      let verified: Control | undefined;
      for (const control of recoveryPage.chain) {
        await checkControl(control, verified);
        verified = control;
      }
      let more = recoveryPage.more;
      while (more) {
        const response = await f.auth(
          "recover-chain",
          { generation: verified!.generation },
          "recovery",
          recovery.signing,
        );
        expect(response.status).toBe(200);
        expect(await responseBytes(response)).toBeLessThanOrEqual(recoveryBudget);
        const page = await response.json<SyncReply>();
        expect(page.fromGeneration).toBe(verified!.generation);
        expect(page.chain.length).toBeGreaterThan(0);
        for (const control of page.chain) {
          await checkControl(control, verified);
          verified = control;
        }
        expect(page.nextGeneration).toBe(verified!.generation);
        more = page.more;
      }
      expect(verified).toEqual(rotated);
      expect((await f.post("recover-chain", { generation: 0 })).status).toBe(400);
      expect((await f.auth("recover-chain", { generation: 0 })).status).toBe(403);
      expect(
        (await f.auth("recover-chain", { generation: 0 }, "recovery", f.device.signing)).status,
      ).toBe(403);
      for (let index = 0; index < 4; index++)
        expect((await f.post("recover-info", { pagination: true })).status).toBe(200);
      expect((await f.post("recover-info", { pagination: true })).status).toBe(429);
      for (let index = 0; index < 8; index++)
        expect(
          (await f.auth("recover-chain", { generation: 1 }, "recovery", recovery.signing)).status,
        ).toBe(200);
      expect(
        (await f.auth("recover-chain", { generation: 3 }, "recovery", recovery.signing)).status,
      ).toBe(409);
    } finally {
      delete testEnv.SYNC_RESPONSE_BYTE_BUDGET;
      socket.close();
    }
  });
  it("recovers a valid signed history larger than the client transport limit", async () => {
    const setup = await fixture();
    const wrapping = await derive(setup.secret, setup.handle, "relay/recovery-wrap/v1");
    const aad = { version: 1, account: setup.handle, type: "recovery-identity" };
    const recoveryPackage = await open<Record<string, unknown>>(
      wrapping,
      setup.control.recovery.blob,
      aad,
    );
    // Extra encrypted metadata remains opaque to the server. The package still
    // recovers its real keys, and every signed request is below the 2 MB limit.
    const recovery = {
      ...setup.control.recovery,
      blob: await seal(wrapping, { ...recoveryPackage, padding: "x".repeat(900_000) }, aad),
    };
    setup.control = await makeControl(
      { ...controlBody(setup.control), recovery },
      setup.device.signing,
    );
    const f = await client(setup);
    const keys = await recoverIdentity(f.secret, f.handle, recovery);
    const history = [f.control];
    let current = f.control;
    for (let generation = 1; generation <= 6; generation++) {
      const device = (await identity()).device;
      current = await makeControl(
        {
          ...controlBody(current),
          generation,
          previous: await controlHash(current),
          actor: "recovery",
          members: [...current.members, device],
          boxes: {
            ...current.boxes,
            [device.id]: await wrapRoot(f.root, device.exchange, f.handle, 1, device.id),
          },
        },
        keys.signing,
      );
      expect(
        (await f.auth("recover-join", { control: current }, "recovery", keys.signing)).status,
      ).toBe(200);
      history.push(current);
    }
    const legacyBytes = new TextEncoder().encode(
      JSON.stringify({ recovery, chain: history }),
    ).byteLength;
    expect(legacyBytes).toBeGreaterThan(SYNC_CLIENT_RESPONSE_BYTE_LIMIT);
    expect((await f.post("recover-info", {})).status).toBe(409);
    let response = await f.post("recover-info", { pagination: true });
    let verified: Control | undefined;
    let pages = 0;
    while (true) {
      expect(response.status).toBe(200);
      expect(await responseBytes(response)).toBeLessThanOrEqual(SYNC_RESPONSE_BYTE_BUDGET);
      const page = await response.json<SyncReply>();
      expect(page.fromGeneration).toBe(verified?.generation ?? -1);
      expect(page.chain.length).toBeGreaterThan(0);
      for (const control of page.chain) {
        await checkControl(control, verified);
        verified = control;
      }
      expect(page.nextGeneration).toBe(verified!.generation);
      pages++;
      if (!page.more) break;
      expect(pages).toBeLessThan(LIMITS.control);
      response = await f.auth(
        "recover-chain",
        { generation: verified!.generation },
        "recovery",
        keys.signing,
      );
    }
    expect(pages).toBeGreaterThan(1);
    expect(verified!.generation).toBe(6);
    expect(await controlHash(verified!)).toBe(await controlHash(current));
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
    const { ticket } = await (await f.auth("socket-ticket", {}, b.device.id, b.signing)).json<{
      ticket: string;
    }>();
    const opened = await f.stub.fetch(`http://relay/v1/${f.handle}/socket?ticket=${ticket}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(opened.status).toBe(101);
    opened.webSocket!.accept();
    const originalSend = WebSocket.prototype.send;
    const send = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      data,
    ) {
      if (typeof data === "string" && data.includes('"type":"revoked"'))
        throw new Error("Synthetic disconnected socket");
      return originalSend.call(this, data);
    });
    try {
      expect((await f.auth("rotate", { control: rotated, snapshot })).status).toBe(200);
      expect(send).toHaveBeenCalled();
    } finally {
      send.mockRestore();
      opened.webSocket!.close();
    }
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
