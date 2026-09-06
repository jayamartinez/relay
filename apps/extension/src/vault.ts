// SPDX-License-Identifier: AGPL-3.0-or-later
import { open, seal } from "@relay/crypto";
import type { Cipher } from "@relay/protocol";
import { storageError } from "./storage-runtime";

const DB = "relay-v1";
export async function remove(key: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("vault", "readwrite");
      tx.objectStore("vault").delete(key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
    });
  } finally {
    db.close();
  }
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("vault");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError(req.error));
  });
}
export async function read<T>(key: string): Promise<T | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("vault").objectStore("vault").get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(storageError(request.error));
    });
  } finally {
    db.close();
  }
}
export async function write(key: string, value: unknown): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("vault", "readwrite");
      tx.objectStore("vault").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => reject(storageError(tx.error));
    });
  } finally {
    db.close();
  }
}
async function storageKey(): Promise<CryptoKey> {
  const existing = await read<CryptoKey>("storage-key");
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await write("storage-key", key);
  return key;
}
export async function saveState(value: unknown): Promise<void> {
  await write(
    "state",
    await seal(await storageKey(), value, { type: "relay-local-state", version: 1 }),
  );
}
export async function loadState<T>(): Promise<T | undefined> {
  const cipher = await read<Cipher>("state");
  if (!cipher) return undefined;
  const key = await read<CryptoKey>("storage-key");
  if (!key) throw new Error("Local key storage is incomplete. Data has not been reset.");
  return open<T>(key, cipher, { type: "relay-local-state", version: 1 });
}
export async function wipe(): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("vault", "readwrite");
      tx.objectStore("vault").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
