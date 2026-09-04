import { emptyWorkspace, type LogicalTab } from "@relay/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { capture, reconcile } from "./browser";
import { BrowserEvents } from "./browser-events";
import type { Mapping } from "./browser-model";

afterEach(() => vi.unstubAllGlobals());
function fixture(existing: boolean) {
  const tab: LogicalTab = {
    id: "tab",
    window: "window",
    kind: "web",
    url: "https://example.com/",
    pinned: false,
    index: 0,
    source: "peer",
    changed: 1,
  };
  const target = {
    ...emptyWorkspace(),
    windows: { window: { id: "window", order: 0, changed: 1 } },
    tabs: { tab },
  } as const;
  let live = existing
    ? [{ id: 7, windowId: 1, index: 0, pinned: false, incognito: false, url: tab.url }]
    : [];
  const create = vi.fn(async () => {
    live = [{ id: 7, windowId: 1, index: 0, pinned: false, incognito: false, url: tab.url }];
    // Chrome can return an initializing tab before its URL/pendingUrl is populated.
    return { ...live[0], url: undefined };
  });
  const update = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: { getURL: () => "chrome-extension://relay/" },
    storage: { session: { get: async () => ({ browserSession: "session" }) } },
    windows: { getAll: async () => [{ id: 1, tabs: live, incognito: false }] },
    tabs: {
      create,
      update,
      get: async () => live[0],
      query: async () => live,
      move: vi.fn(),
      remove: vi.fn(),
    },
  });
  const mapping: Mapping = {
    session: "session",
    windows: { 1: "window" },
    tabs: existing ? { 7: "tab" } : {},
    expected: [],
    observed: existing ? target : { ...target, tabs: {} },
  };
  return { target, mapping, create, update };
}
it("does not navigate again after create returns an initializing tab without URL metadata", async () => {
  const f = fixture(false);
  const mapping = await reconcile(f.target, f.mapping, "device", async () => {});
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.update).not.toHaveBeenCalled();
  expect(mapping.tabs[7]).toBe("tab");
});
it("makes zero update calls for an already-current tab and emits no delayed callback echoes", async () => {
  const f = fixture(true);
  let mapping = await reconcile(f.target, f.mapping, "device", async () => {});
  expect(f.update).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
  for (let index = 0; index < 4; index++) {
    const events = new BrowserEvents();
    events.navigation(7, "https://example.com/", index > 1, 0);
    const result = await capture(mapping, "device", events.take(200)!, f.target);
    expect(result.changes).toEqual([]);
    mapping = result.mapping;
  }
});
