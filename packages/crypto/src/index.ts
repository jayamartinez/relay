// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Cipher,
  type Control,
  type ControlBody,
  controlBody,
  type Device,
  type Envelope,
  type Header,
  type KeyBox,
  type PairTranscript,
  type Recovery,
  type Reveal,
  sameDevice,
} from "@relay/protocol";
import { assert, canonical, canonicalAccount } from "@relay/shared";

const encoder = new TextEncoder();
export const bytes = (value: string) => encoder.encode(value);
export function base64(value: ArrayBuffer | Uint8Array): string {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  let raw = "";
  for (let offset = 0; offset < data.length; offset += 8192)
    raw += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(raw);
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function exportBytes(format: "raw" | "pkcs8", key: CryptoKey): Promise<ArrayBuffer> {
  return (await crypto.subtle.exportKey(format, key)) as ArrayBuffer;
}
export const randomKey = () => crypto.getRandomValues(new Uint8Array(32));
export async function hash(value: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return base64(
    await crypto.subtle.digest("SHA-256", typeof value === "string" ? bytes(value) : value),
  );
}
export async function accountHandle(account: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(canonicalAccount(account)))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function accountNumber(): string {
  let result = "";
  while (result.length < 24)
    for (const value of crypto.getRandomValues(new Uint8Array(32)))
      if (value < 250 && result.length < 24) result += value % 10;
  return result;
}
export function recoveryCode(secret: Uint8Array): string {
  return (
    Array.from(secret, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
      .match(/.{4}/g)
      ?.join("-") ?? ""
  );
}
export function parseRecovery(value: string): Uint8Array<ArrayBuffer> {
  const raw = value.replace(/[\s-]/g, "");
  assert(/^[a-fA-F0-9]{64}$/.test(raw), "Enter the complete recovery key.");
  return Uint8Array.from(raw.match(/../g) ?? [], (part) => Number.parseInt(part, 16));
}
export async function derive(
  secret: Uint8Array<ArrayBuffer>,
  salt: string,
  purpose: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: bytes(purpose) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(key: CryptoKey, value: unknown, aad: unknown): Promise<Cipher> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: bytes(canonical(aad)), tagLength: 128 },
    key,
    bytes(canonical(value)),
  );
  return { nonce: base64(nonce), ciphertext: base64(ciphertext) };
}
export async function open<T>(key: CryptoKey, cipher: Cipher, aad: unknown): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unbase64(cipher.nonce),
      additionalData: bytes(canonical(aad)),
      tagLength: 128,
    },
    key,
    unbase64(cipher.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
export interface Identity {
  device: Device;
  signing: CryptoKey;
  exchange: CryptoKey;
}
async function keypair(name: "ECDSA" | "ECDH", extractable = false): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name, namedCurve: "P-256" },
    extractable,
    name === "ECDSA" ? ["sign", "verify"] : ["deriveBits"],
  ) as Promise<CryptoKeyPair>;
}
export async function identity(): Promise<Identity> {
  const signing = await keypair("ECDSA");
  const exchange = await keypair("ECDH");
  return {
    device: {
      id: crypto.randomUUID(),
      auth: base64(await exportBytes("raw", signing.publicKey)),
      exchange: base64(await exportBytes("raw", exchange.publicKey)),
    },
    signing: signing.privateKey,
    exchange: exchange.privateKey,
  };
}
export async function sign(key: CryptoKey, value: unknown): Promise<string> {
  return base64(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes(canonical(value))),
  );
}
export async function verify(
  publicKey: string,
  value: unknown,
  signature: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      unbase64(publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      unbase64(signature),
      bytes(canonical(value)),
    );
  } catch {
    return false;
  }
}
async function shared(privateKey: CryptoKey, publicKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    unbase64(publicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const algorithm = { name: "ECDH", public: key };
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, privateKey, 256));
}
export async function ephemeral(): Promise<{
  privateKey: CryptoKey;
  reveal: Reveal;
  commitment: string;
}> {
  const pair = await keypair("ECDH");
  const reveal = {
    ephemeral: base64(await exportBytes("raw", pair.publicKey)),
    random: base64(randomKey()),
  };
  return { privateKey: pair.privateKey, reveal, commitment: await hash(canonical(reveal)) };
}
export async function pairing(
  privateKey: CryptoKey,
  role: "requester" | "approver",
  transcript: PairTranscript,
): Promise<{ key: CryptoKey; sas: string }> {
  assert(transcript.request.expires > Date.now(), "Approval expired. Start again.");
  assert(
    (await hash(canonical(transcript.requesterReveal))) === transcript.request.commitment &&
      (await hash(canonical(transcript.approverReveal))) === transcript.offer.commitment,
    "Pairing commitment mismatch.",
  );
  const secret = await shared(
    privateKey,
    role === "requester"
      ? transcript.approverReveal.ephemeral
      : transcript.requesterReveal.ephemeral,
  );
  const transcriptHash = await hash(canonical(transcript));
  const key = await derive(secret, transcriptHash, "relay/pair-wrap/v1");
  const sasMaterial = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const output = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: bytes(transcriptHash),
        info: bytes("relay/pair-sas/v1"),
      },
      sasMaterial,
      256,
    ),
  );
  const number = new DataView(output.buffer).getUint32(0) % 1_000_000;
  return {
    key,
    sas: number
      .toString()
      .padStart(6, "0")
      .replace(/(...)(...)/, "$1 $2"),
  };
}
export async function wrapRoot(
  root: Uint8Array<ArrayBuffer>,
  publicKey: string,
  account: string,
  epoch: number,
  recipient: string,
): Promise<KeyBox> {
  const pair = await keypair("ECDH");
  const ephemeralKey = base64(await exportBytes("raw", pair.publicKey));
  const aad = { version: 1, account, epoch, recipient, type: "root-box", ephemeral: ephemeralKey };
  const key = await derive(
    await shared(pair.privateKey, publicKey),
    account,
    `relay/device-wrap/v1/${epoch}/${recipient}`,
  );
  return { ...(await seal(key, { root: base64(root) }, aad)), ephemeral: ephemeralKey };
}
export async function unwrapRoot(
  box: KeyBox,
  privateKey: CryptoKey,
  account: string,
  epoch: number,
  recipient: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await derive(
    await shared(privateKey, box.ephemeral),
    account,
    `relay/device-wrap/v1/${epoch}/${recipient}`,
  );
  const result = await open<{ root: string }>(key, box, {
    version: 1,
    account,
    epoch,
    recipient,
    type: "root-box",
    ephemeral: box.ephemeral,
  });
  const root = unbase64(result.root);
  assert(root.length === 32);
  return root;
}
export async function makeRecovery(
  secret: Uint8Array<ArrayBuffer>,
  account: string,
): Promise<Recovery> {
  const signing = await keypair("ECDSA", true);
  const exchange = await keypair("ECDH", true);
  const auth = base64(await exportBytes("raw", signing.publicKey));
  const publicExchange = base64(await exportBytes("raw", exchange.publicKey));
  const blob = await seal(
    await derive(secret, account, "relay/recovery-wrap/v1"),
    {
      signing: base64(await exportBytes("pkcs8", signing.privateKey)),
      exchange: base64(await exportBytes("pkcs8", exchange.privateKey)),
      auth,
      publicExchange,
    },
    { version: 1, account, type: "recovery-identity" },
  );
  return { auth, exchange: publicExchange, blob };
}
export async function recoverIdentity(
  secret: Uint8Array<ArrayBuffer>,
  account: string,
  recovery: Recovery,
): Promise<{ signing: CryptoKey; exchange: CryptoKey }> {
  const value = await open<{
    signing: string;
    exchange: string;
    auth: string;
    publicExchange: string;
  }>(await derive(secret, account, "relay/recovery-wrap/v1"), recovery.blob, {
    version: 1,
    account,
    type: "recovery-identity",
  });
  assert(
    value.auth === recovery.auth && value.publicExchange === recovery.exchange,
    "Recovery identity mismatch.",
  );
  return {
    signing: await crypto.subtle.importKey(
      "pkcs8",
      unbase64(value.signing),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    ),
    exchange: await crypto.subtle.importKey(
      "pkcs8",
      unbase64(value.exchange),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
  };
}
export async function encryptEnvelope(
  root: Uint8Array<ArrayBuffer>,
  signing: CryptoKey,
  header: Header,
  value: unknown,
): Promise<Envelope> {
  const cipher = await seal(
    await derive(root, header.account, `relay/${header.type}/v1/${header.epoch}`),
    value,
    header,
  );
  return { header, cipher, signature: await sign(signing, { header, cipher }) };
}
export async function decryptEnvelope<T>(
  root: Uint8Array<ArrayBuffer>,
  envelope: Envelope,
  member: Device,
  account: string,
  epoch: number,
): Promise<T> {
  assert(
    envelope.header.account === account &&
      envelope.header.epoch === epoch &&
      envelope.header.sender === member.id,
    "Envelope context mismatch.",
  );
  assert(
    await verify(
      member.auth,
      { header: envelope.header, cipher: envelope.cipher },
      envelope.signature,
    ),
    "Invalid workspace signature.",
  );
  return open<T>(
    await derive(root, account, `relay/${envelope.header.type}/v1/${epoch}`),
    envelope.cipher,
    envelope.header,
  );
}
export async function makeControl(body: ControlBody, signing: CryptoKey): Promise<Control> {
  return { ...body, signature: await sign(signing, body) };
}
export async function controlHash(control: Control): Promise<string> {
  return hash(canonical(control));
}
export async function checkControl(control: Control, previous?: Control): Promise<void> {
  const body = controlBody(control);
  if (!previous) {
    assert(
      control.generation === 0 &&
        control.previous === "genesis" &&
        control.epoch === 1 &&
        control.members.length === 1,
    );
    const creator = control.members[0];
    assert(
      creator &&
        creator.id === control.actor &&
        (await verify(creator.auth, body, control.signature)),
    );
    return;
  }
  assert(
    control.account === previous.account &&
      control.previous === (await controlHash(previous)) &&
      control.generation === previous.generation + 1,
    "Membership chain mismatch.",
  );
  assert(
    canonical(control.recovery) === canonical(previous.recovery),
    "Unexpected recovery identity change.",
  );
  const signer =
    control.actor === "recovery"
      ? previous.recovery.auth
      : previous.members.find((d) => d.id === control.actor)?.auth;
  assert(
    signer && (await verify(signer, body, control.signature)),
    "Membership signature invalid.",
  );
  for (const device of control.members) {
    const old = previous.members.find((d) => d.id === device.id);
    assert(!old || sameDevice(old, device), "Device key substitution rejected.");
  }
  const removed = previous.members.filter((d) => !control.members.some((n) => n.id === d.id));
  const added = control.members.filter((d) => !previous.members.some((n) => n.id === d.id));
  assert(
    (removed.length === 1 &&
      added.length === 0 &&
      control.epoch === previous.epoch + 1 &&
      control.actor !== removed[0]?.id) ||
      (removed.length === 0 && added.length === 1 && control.epoch === previous.epoch),
    "Invalid membership transition.",
  );
  if (!removed.length)
    for (const device of [...previous.members, { id: "recovery" }])
      assert(
        canonical(control.boxes[device.id]) === canonical(previous.boxes[device.id]),
        "Enrollment cannot alter existing key boxes.",
      );
}
