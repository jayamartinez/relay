import { applyOperation, type Change, emptyWorkspace, type Workspace } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import { BrowserEvents } from "./browser-events";
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
    const changes = authorizedChanges(diffWorkspace(prior, observed), m, actual, events.take(600)!);
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
    expect(events.take(600)).toBeUndefined();
    const evidence = events.take(900)!;
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
});
