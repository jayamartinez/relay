import { emptyWorkspace, type LogicalTab } from "@relay/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { capture, reconcile } from "./browser";
import { BrowserEvents } from "./browser-events";
import { browserWorkspace, type Mapping, observe } from "./browser-model";
import { BrowserRuntimeRaceError } from "./browser-runtime";

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

it("projects tied canonical ordering keys into contiguous browser positions without rewriting canonical state", () => {
  const f = fixture(true);
  const state = {
    ...f.target,
    tabs: {
      a: { ...f.target.tabs.tab, id: "a", index: 5 },
      b: { ...f.target.tabs.tab, id: "b", index: 5 },
      c: { ...f.target.tabs.tab, id: "c", index: 9, pinned: true },
    },
  };
  const before = structuredClone(state);
  const projected = browserWorkspace(state);
  expect([projected.tabs.c!.index, projected.tabs.a!.index, projected.tabs.b!.index]).toEqual([
    0, 1, 2,
  ]);
  expect(state).toEqual(before);
});

it("keeps both duplicate URLs when a new tab appears before an already mapped tab", () => {
  const f = fixture(true);
  const tabs = [8, 7].map((local, index) => ({
    local,
    window: 1,
    index,
    pinned: false,
    incognito: false,
    url: f.target.tabs.tab.url,
  }));
  const result = observe(
    [{ local: 1, tabs }],
    f.mapping,
    "session",
    "device",
    "chrome-extension://relay",
  );
  expect(result.mapping.tabs[7]).toBe("tab");
  expect(result.mapping.tabs[8]).not.toBe("tab");
  expect(Object.keys(result.workspace.tabs)).toHaveLength(2);
});

it("does not replay a stale deletion after a tab navigates during reconciliation", async () => {
  const f = fixture(true);
  const get = vi.fn(
    async () =>
      ({
        id: 7,
        windowId: 1,
        index: 0,
        pinned: false,
        incognito: false,
        url: "https://example.com/user-navigation",
      }) as chrome.tabs.Tab,
  );
  chrome.tabs.get = get as typeof chrome.tabs.get;
  await reconcile({ ...f.target, tabs: {} }, f.mapping, "device", async () => {});
  expect(chrome.tabs.remove).not.toHaveBeenCalled();
});

it("does not recreate a tab when a user close supersedes a stale reconcile plan", async () => {
  const f = fixture(false);
  let closed = false;
  await expect(
    reconcile(
      f.target,
      f.mapping,
      "device",
      async () => {
        // The initial reconciliation plan exists, then tabs.onRemoved records a
        // fresh delete intent before Chrome is allowed to create the missing tab.
        closed = true;
      },
      (tab) => !(closed && tab?.id === "tab"),
    ),
  ).rejects.toBeInstanceOf(BrowserRuntimeRaceError);
  expect(f.create).not.toHaveBeenCalled();
});

it("does not restore an older URL when a user navigation supersedes its reconcile plan", async () => {
  const f = fixture(true);
  let navigated = false;
  await expect(
    reconcile(
      { ...f.target, tabs: { tab: { ...f.target.tabs.tab, url: "https://example.com/old" } } },
      f.mapping,
      "device",
      async () => {
        // This models tabs.onUpdated receiving the user's newer URL between plan
        // construction and the awaited tabs.get/tabs.update boundary.
        navigated = true;
      },
      (tab, mutation) => !(navigated && tab?.id === "tab" && mutation === "navigate"),
    ),
  ).rejects.toBeInstanceOf(BrowserRuntimeRaceError);
  expect(f.update).not.toHaveBeenCalled();
});

it("does not restore an old URL while a discarded tab is waking into a user navigation", async () => {
  const f = fixture(true);
  chrome.tabs.get = vi.fn(async () => ({
    id: 7,
    windowId: 1,
    index: 0,
    pinned: false,
    incognito: false,
    url: "https://example.com/old",
    pendingUrl: "https://example.com/new-user-url",
    discarded: true,
  })) as unknown as typeof chrome.tabs.get;
  await expect(
    reconcile(
      { ...f.target, tabs: { tab: { ...f.target.tabs.tab, url: "https://example.com/old" } } },
      f.mapping,
      "device",
      async () => {},
      (tab, mutation) => !(tab?.id === "tab" && mutation === "navigate"),
    ),
  ).rejects.toBeInstanceOf(BrowserRuntimeRaceError);
  expect(f.update).not.toHaveBeenCalled();
});
