import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { StorageInterruptedError } from "./storage-runtime";
import { loadState, read, saveState, wipe } from "./vault";

it("persists encrypted state and non-extractable keys across reload, then wipes", async () => {
  await wipe();
  await saveState({ root: "test-root", queue: ["offline-op"], url: "https://private.example/" });
  const stored = await read("state");
  expect(JSON.stringify(stored)).not.toContain("private.example");
  expect((await read<CryptoKey>("storage-key"))?.extractable).toBe(false);
  expect(await loadState()).toEqual({
    root: "test-root",
    queue: ["offline-op"],
    url: "https://private.example/",
  });
  await wipe();
  expect(await loadState()).toBeUndefined();
  expect(await read("storage-key")).toBeUndefined();
});

it("rejects an aborted wipe and preserves state for a successful retry", async () => {
  await saveState({ queue: ["pending"] });
  const clear = IDBObjectStore.prototype.clear;
  let aborted!: () => void;
  const onAbort = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const spy = vi.spyOn(IDBObjectStore.prototype, "clear").mockImplementationOnce(function (
    this: IDBObjectStore,
  ) {
    this.transaction.addEventListener("abort", aborted);
    const request = clear.call(this);
    request.onsuccess = () => this.transaction.abort();
    return request;
  });
  let result: unknown = "pending";
  const wiping = wipe().then(
    () => {
      result = "completed";
    },
    (error) => {
      result = error;
    },
  );
  try {
    await onAbort;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result).toBeInstanceOf(StorageInterruptedError);
    await wiping;
    expect(await loadState()).toEqual({ queue: ["pending"] });
    await wipe();
    expect(await loadState()).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});
