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
import { type Challenge, type Control, controlBody, type SyncReply } from "@relay/protocol";
import { canonical } from "@relay/shared";
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
describe("SQLite Durable Object", () => {
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
    expect(sync.sequence).toBe(1);
    expect(JSON.stringify(sync.operations)).not.toContain("window-create");
    const snapshot = await encryptEnvelope(
      f.root,
      f.device.signing,
      { ...f.snapshot.header, base: 1 },
      { ...f.workspace, revision: 1, sequences: { [f.device.device.id]: 1 } },
    );
    expect((await f.auth("checkpoint", { snapshot })).status).toBe(200);
    const resumed = await (await f.auth("sync", { since: 0, generation: 0 })).json<SyncReply>();
    expect(resumed.snapshot?.header.base).toBe(1);
    expect(resumed.operations).toHaveLength(0);
    expect((await f.auth("checkpoint", { snapshot: f.snapshot })).status).toBe(409);
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
