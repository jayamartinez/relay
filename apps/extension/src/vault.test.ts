import "fake-indexeddb/auto";
import { expect, it } from "vitest";
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
