import { controlBody, type PairTranscript } from "@relay/protocol";
import { canonical } from "@relay/shared";
import { describe, expect, it } from "vitest";
import { fixture } from "../../../tests/fixtures";
import {
  accountHandle,
  accountNumber,
  base64,
  checkControl,
  controlHash,
  decryptEnvelope,
  derive,
  ephemeral,
  hash,
  identity,
  makeControl,
  open,
  pairing,
  parseRecovery,
  randomKey,
  recoverIdentity,
  recoveryCode,
  seal,
  unwrapRoot,
  wrapRoot,
} from "./index";

describe("Web Crypto and account boundaries", () => {
  it("generates independent 256-bit keys and 24 decimal digits", () => {
    expect(randomKey()).toHaveLength(32);
    expect(base64(randomKey())).not.toBe(base64(randomKey()));
    for (let n = 0; n < 20; n++) expect(accountNumber()).toMatch(/^\d{24}$/);
  });
  it("preserves leading zeros and ignores display spaces", async () => {
    expect(await accountHandle("0000 1234 5678 9012 3456 7890")).toBe(
      await accountHandle("000012345678901234567890"),
    );
  });
  it("round-trips the entire recovery entropy", () => {
    const secret = randomKey();
    expect(parseRecovery(recoveryCode(secret))).toEqual(secret);
  });
  it("persists non-extractable device private keys", async () => {
    const keys = await identity();
    expect(keys.signing.extractable).toBe(false);
    expect(keys.exchange.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", keys.signing)).rejects.toThrow();
  });
  it("recovers root locally and rejects an incorrect recovery secret", async () => {
    const f = await fixture();
    const keys = await recoverIdentity(f.secret, f.handle, f.control.recovery);
    expect(
      await unwrapRoot(f.control.boxes.recovery!, keys.exchange, f.handle, 1, "recovery"),
    ).toEqual(f.root);
    await expect(recoverIdentity(randomKey(), f.handle, f.control.recovery)).rejects.toThrow();
  });
  it("uses unique message nonces and authenticates ciphertext/AAD", async () => {
    const key = await derive(randomKey(), "account", "test");
    const packets = await Promise.all(
      Array.from({ length: 100 }, () =>
        seal(key, { url: "https://private.example/" }, { epoch: 1 }),
      ),
    );
    expect(new Set(packets.map((p) => p.nonce)).size).toBe(100);
    const cipher = packets[0]!;
    expect(await open(key, cipher, { epoch: 1 })).toEqual({ url: "https://private.example/" });
    await expect(open(key, cipher, { epoch: 2 })).rejects.toThrow();
    await expect(
      open(
        key,
        {
          ...cipher,
          ciphertext: (cipher.ciphertext[0] === "A" ? "B" : "A") + cipher.ciphertext.slice(1),
        },
        { epoch: 1 },
      ),
    ).rejects.toThrow();
  });
  it("binds device root boxes to recipient/account/epoch", async () => {
    const f = await fixture();
    const box = f.control.boxes[f.device.device.id]!;
    expect(await unwrapRoot(box, f.device.exchange, f.handle, 1, f.device.device.id)).toEqual(
      f.root,
    );
    await expect(
      unwrapRoot(box, f.device.exchange, f.handle, 2, f.device.device.id),
    ).rejects.toThrow();
    await expect(
      unwrapRoot(box, (await identity()).exchange, f.handle, 1, f.device.device.id),
    ).rejects.toThrow();
  });
  it("rejects envelope signature and epoch tampering", async () => {
    const f = await fixture();
    expect(await decryptEnvelope(f.root, f.snapshot, f.device.device, f.handle, 1)).toEqual(
      f.workspace,
    );
    await expect(
      decryptEnvelope(
        f.root,
        { ...f.snapshot, header: { ...f.snapshot.header, base: 99 } },
        f.device.device,
        f.handle,
        1,
      ),
    ).rejects.toThrow();
    await expect(
      decryptEnvelope(randomKey(), f.snapshot, f.device.device, f.handle, 1),
    ).rejects.toThrow();
  });
});
describe("Committed pairing transcript", () => {
  async function setup() {
    const a = await ephemeral();
    const b = await ephemeral();
    const transcript: PairTranscript = {
      version: 1,
      account: "account",
      request: {
        id: crypto.randomUUID(),
        device: (await identity()).device,
        commitment: a.commitment,
        expires: Date.now() + 60_000,
      },
      offer: { device: (await identity()).device, commitment: b.commitment },
      requesterReveal: a.reveal,
      approverReveal: b.reveal,
    };
    return { a, b, transcript };
  }
  it("derives the same SAS and wrapping key on both devices", async () => {
    const { a, b, transcript } = await setup();
    const first = await pairing(a.privateKey, "requester", transcript);
    const second = await pairing(b.privateKey, "approver", transcript);
    expect(first.sas).toBe(second.sas);
    expect(first.sas).toMatch(/^\d{3} \d{3}$/);
    expect(
      await open(second.key, await seal(first.key, { test: true }, transcript), transcript),
    ).toEqual({ test: true });
  });
  it("detects public-key substitution and uncommitted ephemeral replacement", async () => {
    const { a, b, transcript } = await setup();
    const original = await pairing(a.privateKey, "requester", transcript);
    const changed = structuredClone(transcript);
    changed.offer.device.auth = (await identity()).device.auth;
    expect((await pairing(b.privateKey, "approver", changed)).sas).not.toBe(original.sas);
    changed.approverReveal = (await ephemeral()).reveal;
    await expect(pairing(a.privateKey, "requester", changed)).rejects.toThrow("commitment");
  });
  it("rejects expired requests", async () => {
    const { a, transcript } = await setup();
    transcript.request.expires = 0;
    await expect(pairing(a.privateKey, "requester", transcript)).rejects.toThrow("expired");
  });
});
describe("Membership and revocation", () => {
  it("checks genesis, signed additions, rotation, and recovery after rotation", async () => {
    const f = await fixture();
    await checkControl(f.control);
    const b = await identity();
    const add = await makeControl(
      {
        ...controlBody(f.control),
        generation: 1,
        previous: await controlHash(f.control),
        members: [f.device.device, b.device],
        boxes: {
          ...f.control.boxes,
          [b.device.id]: await wrapRoot(f.root, b.device.exchange, f.handle, 1, b.device.id),
        },
      },
      f.device.signing,
    );
    await checkControl(add, f.control);
    const nextRoot = randomKey();
    const rotated = await makeControl(
      {
        ...controlBody(add),
        generation: 2,
        previous: await controlHash(add),
        epoch: 2,
        members: [f.device.device],
        boxes: {
          [f.device.device.id]: await wrapRoot(
            nextRoot,
            f.device.device.exchange,
            f.handle,
            2,
            f.device.device.id,
          ),
          recovery: await wrapRoot(nextRoot, add.recovery.exchange, f.handle, 2, "recovery"),
        },
      },
      f.device.signing,
    );
    await checkControl(rotated, add);
    const recovered = await recoverIdentity(f.secret, f.handle, rotated.recovery);
    expect(
      await unwrapRoot(rotated.boxes.recovery!, recovered.exchange, f.handle, 2, "recovery"),
    ).toEqual(nextRoot);
    expect(rotated.boxes[b.device.id]).toBeUndefined();
    await expect(
      unwrapRoot(rotated.boxes[f.device.device.id]!, b.exchange, f.handle, 2, f.device.device.id),
    ).rejects.toThrow();
    await expect(checkControl({ ...rotated, epoch: 1 }, add)).rejects.toThrow();
    const substituted = await makeControl(
      {
        ...controlBody(add),
        members: [{ ...f.device.device, exchange: b.device.exchange }, b.device],
      },
      f.device.signing,
    );
    await expect(checkControl(substituted, f.control)).rejects.toThrow("substitution");
    expect(await hash(canonical(rotated))).not.toBe(await hash(canonical(add)));
  });
});
