import { applyOperation, type Change, emptyWorkspace, type Workspace } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import { BrowserEvents, NAVIGATION_DELAY, WINDOW_CLOSE_DELAY } from "./browser-events";
import {
  authorizedChanges,
  diffWorkspace,
  type Mapping,
  type ObservedWindow,
  observe,
  physicalIndex,
} from "./browser-model";
import { initialMerge, restoreMapping } from "./workspace-lifecycle";

const origin = "chrome-extension://relay";
const url = (name: string) => `https://example.com/${name}`;
function state(names = ["a", "b"]): Workspace {
  return {
    ...emptyWorkspace(),
    windows: { w: { id: "w", order: 0, changed: 0 } },
    tabs: Object.fromEntries(
      names.map((name, index) => [
        name,
        {
          id: name,
          window: "w",
          index,
          pinned: false,
          kind: "web",
          url: url(name),
          source: "A",
          changed: 0,
        },
      ]),
    ),
  };
}
function mapping(workspace = state()): Mapping {
  return {
    session: "old",
    windows: { 1: "w" },
    tabs: Object.fromEntries(Object.keys(workspace.tabs).map((id, index) => [10 + index, id])),
    expected: [],
    observed: workspace,
  };
}
function window(local: number, names: string[]): ObservedWindow {
  return {
    local,
    tabs: names.map((name, index) => ({
      local: local * 10 + index,
      window: local,
      index,
      url: name.includes(":") ? name : url(name),
      pinned: false,
      incognito: false,
    })),
  };
}
const apply = (workspace: Workspace, changes: Change[]) =>
  applyOperation(
    workspace,
    { id: "op", sender: "B", sequence: 1, base: workspace.revision, changes },
    workspace.revision + 1,
  );
describe("Explicit enrollment and device lifetime semantics", () => {
  it("reuses the browser starter new tab for canonical content after restart", () => {
    const restored = restoreMapping(
      [window(7, ["chrome://newtab/"])],
      mapping(),
      state(),
      "new-session",
      "A",
      origin,
    );
    expect(restored.mapping.windows[7]).toBe("w");
    expect(Object.values(restored.mapping.tabs)).toEqual(["a"]);
    expect(restored.changes).toEqual([]);
  });
  it("merges canonical [a,b] and joining [c,d] into one window, reusing the local window", () => {
    const canonical = state();
    const imported = initialMerge(
      [window(2, ["c", "d"])],
      { ...mapping(emptyWorkspace()), windows: {}, tabs: {} },
      canonical,
      "session",
      "B",
      origin,
    );
    const result = apply(canonical, imported.changes);
    expect(imported.mapping.windows).toEqual({ 2: "w" });
    expect(imported.changes.filter((c) => c.type === "window-create")).toEqual([]);
    expect(Object.keys(result.windows)).toEqual(["w"]);
    expect(
      Object.values(result.tabs)
        .sort((a, b) => a.index - b.index)
        .map((t) => t.url),
    ).toEqual([url("a"), url("b"), url("c"), url("d")]);
  });
  it("keeps independent duplicate URLs during join instead of deduplicating by URL", () => {
    const canonical = state(["a"]);
    const imported = initialMerge(
      [window(2, ["a", "a"])],
      { ...mapping(emptyWorkspace()), windows: {}, tabs: {} },
      canonical,
      "session",
      "B",
      origin,
    );
    expect(Object.keys(apply(canonical, imported.changes).tabs)).toHaveLength(3);
  });
  it("preserves genuine multiple joining windows without flattening them", () => {
    const imported = initialMerge(
      [window(2, ["c"]), window(3, ["d"])],
      { ...mapping(emptyWorkspace()), windows: {}, tabs: {} },
      state(),
      "session",
      "B",
      origin,
    );
    expect(Object.keys(apply(state(), imported.changes).windows)).toHaveLength(3);
  });
  it("reuses the one logical window after changed numeric IDs and partial restore", () => {
    const restored = restoreMapping([window(7, ["a"])], mapping(), state(), "new", "B", origin);
    expect(restored.mapping.windows).toEqual({ 7: "w" });
    expect(restored.mapping.tabs).toEqual({ 70: "a" });
    expect(restored.changes).toEqual([]);
  });
  it("never generates window IDs for unmatched resume windows", () => {
    const restored = restoreMapping(
      [window(7, ["local"]), window(8, ["extra"])],
      mapping(),
      state(),
      "new",
      "B",
      origin,
    );
    expect(restored.mapping.windows).toEqual({ 7: "w" });
    expect(restored.mapping.ignoredWindows).toEqual([8]);
    expect(restored.changes.every((c) => c.type !== "window-create")).toBe(true);
  });
  it("restores three identical URLs to three distinct persisted logical IDs by occurrence", () => {
    const canonical = state(["a", "b", "c"]);
    Object.values(canonical.tabs).forEach((t) => {
      t.url = url("same");
    });
    const restored = restoreMapping(
      [window(7, ["same", "same", "same"])],
      mapping(canonical),
      canonical,
      "new",
      "B",
      origin,
    );
    expect(restored.mapping.tabs).toEqual({ 70: "a", 71: "b", 72: "c" });
    expect(restored.changes).toEqual([]);
  });
  it("normal LIVE observation can still import a genuinely created second window", () => {
    const original = mapping();
    const result = observe([window(1, ["a", "b"]), window(2, ["c"])], original, "old", "B", origin);
    expect(
      diffWorkspace(original.observed, result.workspace).filter((c) => c.type === "window-create"),
    ).toHaveLength(1);
  });
  it("closes a non-last window with one cascading window operation and no child deletes", () => {
    const prior = state();
    prior.windows.w2 = { id: "w2", order: 1, changed: 0 };
    prior.tabs.c = { ...prior.tabs.a!, id: "c", window: "w2", url: url("c") };
    const m = {
      ...mapping(prior),
      windows: { 1: "w", 2: "w2" },
      tabs: { 10: "a", 11: "b", 20: "c" },
    };
    const events = new BrowserEvents();
    events.removed(20, 2, true, 0);
    const actual = [window(1, ["a", "b"])];
    const observed = observe(actual, m, "old", "B", origin).workspace;
    const changes = authorizedChanges(
      diffWorkspace(prior, observed),
      m,
      actual,
      events.take(WINDOW_CLOSE_DELAY)!,
    );
    expect(changes).toEqual([{ type: "window-delete", id: "w2" }]);
    const result = apply(prior, changes);
    expect(result.tabs.c).toBeUndefined();
    expect(result.tabs.a).toBeDefined();
    expect(
      applyOperation(result, { id: "op", sender: "B", sequence: 1, base: 0, changes }, 2).tabs,
    ).toEqual(result.tabs);
  });
  it("suppresses all deletes when the last window closes, even with a recent newly used tab", () => {
    const m = mapping(state(["a", "b", "recent"]));
    const events = new BrowserEvents();
    for (const local of [10, 11, 12]) events.removed(local, 1, true, 0);
    const changes = diffWorkspace(m.observed, emptyWorkspace());
    expect(events.pending.closedTabs.size).toBe(0);
    expect(authorizedChanges(changes, m, [], events.take(600)!)).toEqual([]);
  });
  it("coalesces rapid multi-window shutdown and waits for the final close", () => {
    const events = new BrowserEvents();
    events.windowRemoved(1, 0);
    events.windowRemoved(2, 300);
    expect(events.take(WINDOW_CLOSE_DELAY)).toBeUndefined();
    const evidence = events.take(WINDOW_CLOSE_DELAY + 300)!;
    expect([...evidence.closingWindows]).toEqual([1, 2]);
    expect(
      authorizedChanges([{ type: "window-delete", id: "w" }], mapping(), [], evidence),
    ).toEqual([]);
  });
  it("does not infer deletions from a partial/empty startup observation without event evidence", () => {
    const m = mapping();
    const actual = [window(1, ["a"])];
    const observed = observe(actual, m, "old", "B", origin).workspace;
    expect(
      authorizedChanges(
        diffWorkspace(m.observed, observed),
        m,
        actual,
        new BrowserEvents().pending,
      ),
    ).toEqual([]);
  });
  it("omits local/protected tabs and translates compact syncable indices without gaps", () => {
    const actual = [
      window(1, [
        "a",
        "chrome://settings/",
        "b",
        "file:///private.txt",
        "data:text/plain,x",
        "helium://settings/",
        "blob:https://example.com/id",
      ]),
    ];
    const result = observe(actual, mapping(), "old", "B", origin);
    expect(Object.values(result.workspace.tabs).map((t) => t.index)).toEqual([0, 1]);
    expect(Object.values(result.workspace.tabs).map((t) => t.url)).toEqual([url("a"), url("b")]);
    expect(physicalIndex(actual[0]!.tabs, 1, undefined, origin)).toBe(2);
  });

  it.each([1, 20, 70, 200])(
    "adopts a %i-tab native restore with duplicates, pins, and device-local groups",
    (count) => {
      const target = state([]);
      target.version = count >= 20 ? 2 : 1;
      const actual = window(7, []);
      actual.groups = [];
      const previous = mapping(target);
      previous.tabs = {};
      previous.groups = {};
      previous.collapsed = {};
      for (let index = 0; index < count; index++) {
        const id = `tab-${index}`;
        const duplicate = `duplicate-${index % 9}`;
        target.tabs[id] = {
          id,
          window: "w",
          index,
          pinned: index % 17 === 0,
          kind: "web",
          url: url(duplicate),
          source: "A",
          changed: 0,
        };
        previous.tabs[10 + index] = id;
        actual.tabs.push({
          local: 1000 + index,
          window: 7,
          index,
          pinned: index % 17 === 0,
          incognito: false,
          url: url(duplicate),
        });
      }
      previous.observed = structuredClone(target);
      if (count >= 20) {
        for (let groupIndex = 0; groupIndex < Math.min(6, Math.floor(count / 10)); groupIndex++) {
          const id = `group-${groupIndex}`;
          const members = Array.from({ length: 4 }, (_, offset) => groupIndex * 10 + offset + 1)
            .filter((index) => index < count && !target.tabs[`tab-${index}`]!.pinned)
            .map((index) => `tab-${index}`);
          target.groups[id] = {
            id,
            window: "w",
            title: `Group ${groupIndex}`,
            color: groupIndex % 2 ? "blue" : "green",
            tabs: members,
            changed: 0,
          };
          previous.observed.groups[id] = structuredClone(target.groups[id]!);
          previous.groups![50 + groupIndex] = id;
          previous.collapsed![id] = groupIndex % 2 === 0;
          actual.groups!.push({
            local: 500 + groupIndex,
            title: `Group ${groupIndex}`,
            color: groupIndex % 2 ? "blue" : "green",
            collapsed: groupIndex % 2 !== 0,
            tabs: members.map((id) => 1000 + Number(id.slice(4))),
          });
        }
      }

      const restored = restoreMapping([actual], previous, target, "new", "B", origin);

      expect(restored.changes).toEqual([]);
      expect(Object.keys(restored.mapping.tabs)).toHaveLength(count);
      expect(new Set(Object.values(restored.mapping.tabs)).size).toBe(count);
      expect(Object.keys(restored.mapping.groups ?? {})).toHaveLength(
        Object.keys(target.groups).length,
      );
      for (const [native, logical] of Object.entries(restored.mapping.groups ?? {}))
        expect(restored.mapping.collapsed?.[logical]).toBe(
          actual.groups!.find((group) => group.local === Number(native))?.collapsed,
        );
    },
  );

  it("keeps processing a 200-tab rapid close, navigation, and create burst", () => {
    const prior = state([]);
    const m = mapping(prior);
    m.tabs = {};
    const actual = window(1, []);
    const events = new BrowserEvents();
    for (let index = 0; index < 200; index++) {
      const id = `stress-${index}`;
      prior.tabs[id] = {
        id,
        window: "w",
        index,
        pinned: index % 19 === 0,
        kind: "web",
        url: url(`same-${index % 8}`),
        source: "A",
        changed: 0,
      };
      m.tabs[1000 + index] = id;
      if (index < 70) events.removed(1000 + index, 1, false, 0);
      else {
        const navigated = index < 140;
        actual.tabs.push({
          local: 1000 + index,
          window: 1,
          index: index - 70,
          pinned: index % 19 === 0,
          incognito: false,
          url: navigated ? url(`navigated-${index}`) : url(`same-${index % 8}`),
        });
        if (navigated) events.navigation(1000 + index, url(`navigated-${index}`), true, 0);
      }
    }
    for (let index = 0; index < 20; index++)
      actual.tabs.push({
        local: 2000 + index,
        window: 1,
        index: actual.tabs.length,
        pinned: false,
        incognito: false,
        url: url(`created-${index % 4}`),
      });
    m.observed = structuredClone(prior);

    const observed = observe([actual], m, "old", "B", origin);
    const changes = authorizedChanges(
      diffWorkspace(prior, observed.workspace),
      m,
      [actual],
      events.take(NAVIGATION_DELAY)!,
    );

    expect(changes.filter((change) => change.type === "tab-delete")).toHaveLength(70);
    expect(changes.filter((change) => change.type === "tab-navigate")).toHaveLength(70);
    expect(changes.filter((change) => change.type === "tab-create")).toHaveLength(20);
  });

  it.each([70, 200])("suppresses a %i-tab multi-window browser shutdown", (count) => {
    const prior = state([]);
    prior.windows.w2 = { id: "w2", order: 1, changed: 0 };
    const m = mapping(prior);
    m.windows = { 1: "w", 2: "w2" };
    m.tabs = {};
    const events = new BrowserEvents();
    for (let index = 0; index < count; index++) {
      const logical = `shutdown-${index}`;
      const local = 1000 + index;
      const nativeWindow = index < count / 2 ? 1 : 2;
      const logicalWindow = nativeWindow === 1 ? "w" : "w2";
      prior.tabs[logical] = {
        id: logical,
        window: logicalWindow,
        index: index,
        pinned: false,
        kind: "web",
        url: url(`shutdown-${index % 5}`),
        source: "A",
        changed: 0,
      };
      m.tabs[local] = logical;
      events.removed(local, nativeWindow, true, index * 2);
    }
    m.observed = structuredClone(prior);
    const evidence = events.take(count * 2 + WINDOW_CLOSE_DELAY)!;

    expect(authorizedChanges(diffWorkspace(prior, emptyWorkspace()), m, [], evidence)).toEqual([]);
  });
});
