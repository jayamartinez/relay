import { emptyWorkspace, type LogicalGroup } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import {
  diffWorkspace,
  expectation,
  type Mapping,
  type ObservedWindow,
  observe,
  suppress,
} from "./browser-model";
import { pruneCollapsedGroups, updateCollapsedGroup } from "./group-model";

const group: LogicalGroup = {
  id: "g",
  window: "w",
  title: "Work",
  color: "green",
  tabs: ["a", "b"],
  changed: 7,
  writer: "peer",
};
const origin = "chrome-extension://relay";
function setup() {
  const mapping: Mapping = {
    session: "session",
    tabs: { 10: "a", 11: "b" },
    windows: { 1: "w" },
    groups: { 5: "g" },
    expected: [],
    observed: {
      ...emptyWorkspace(),
      version: 2,
      windows: { w: { id: "w", order: 0, changed: 0 } },
      groups: { g: group },
      tabs: Object.fromEntries(
        ["a", "b"].map((id, index) => [
          id,
          {
            id,
            window: "w",
            kind: "web",
            url: `https://example.com/${id}`,
            pinned: false,
            index,
            changed: 0,
            source: "device",
          },
        ]),
      ),
    },
  };
  const windows: ObservedWindow[] = [
    {
      local: 1,
      tabs: [10, 11].map((local, index) => ({
        local,
        window: 1,
        index,
        pinned: false,
        incognito: false,
        url: `https://example.com/${index ? "b" : "a"}`,
      })),
      groups: [{ local: 5, title: "Work", color: "green", collapsed: false, tabs: [10, 11] }],
    },
  ];
  return { mapping, windows };
}
describe("Group browser identity and echo suppression", () => {
  it("remaps session-local group IDs using already-remapped member identities", () => {
    const { mapping, windows } = setup();
    windows[0]!.local = 2;
    windows[0]!.tabs.forEach((t, i) => {
      t.local = 20 + i;
      t.window = 2;
    });
    Object.assign(windows[0]!.groups![0]!, { local: 50, tabs: [20, 21] });
    const result = observe(windows, mapping, "new-session", "device", origin);
    expect(result.mapping.groups).toEqual({ 50: "g" });
    expect(diffWorkspace(mapping.observed, result.workspace)).toEqual([]);
  });
  it("preserves a Relay group ID when native cross-window move replaces its ID", () => {
    const { mapping, windows } = setup();
    windows[0]!.local = 2;
    windows[0]!.tabs.forEach((t) => {
      t.window = 2;
    });
    windows[0]!.groups![0]!.local = 50;
    const result = observe(windows, mapping, "session", "device", origin);
    expect(result.mapping.groups).toEqual({ 50: "g" });
    expect(result.workspace.groups.g?.window).not.toBe("w");
  });
  it("does not upload collapsed state, and suppresses exact remote group effects", () => {
    const { mapping, windows } = setup();
    windows[0]!.groups![0]!.collapsed = true;
    const result = observe(windows, mapping, "session", "device", origin);
    expect(result.mapping.collapsed?.g).toBe(true);
    expect(diffWorkspace(mapping.observed, result.workspace)).toEqual([]);
    expect(JSON.stringify(result.workspace)).not.toContain("collapsed");
    const create = { type: "group-create" as const, group };
    expect(
      suppress({ ...create, group: { ...group, changed: 0, writer: undefined } }, [
        expectation(create, "op"),
      ]),
    ).toBe(true);
    const rename = { type: "group-title" as const, id: "g", title: "Remote" };
    expect(suppress(rename, [expectation(rename, "op")])).toBe(true);
    expect(suppress({ ...rename, title: "User" }, [expectation(rename, "op")])).toBe(false);
  });
  it.each([true, false])(
    "adopts a browser-restored group with collapsed=%s after its native ID changes",
    (collapsed) => {
      const { mapping, windows } = setup();
      windows[0]!.local = 2;
      windows[0]!.tabs.forEach((tab, index) => {
        tab.local = 20 + index;
        tab.window = 2;
      });
      Object.assign(windows[0]!.groups![0]!, { local: 50, tabs: [20, 21], collapsed });

      const result = observe(windows, mapping, "new-session", "device", origin);

      expect(result.mapping.groups).toEqual({ 50: "g" });
      expect(result.mapping.collapsed).toEqual({ g: collapsed });
      expect(diffWorkspace(mapping.observed, result.workspace)).toEqual([]);
    },
  );
  it("keeps opposite collapsed preferences local to two devices", () => {
    const deviceA = setup();
    const deviceB = structuredClone(deviceA);
    deviceA.windows[0]!.groups![0]!.collapsed = true;
    deviceB.windows[0]!.groups![0]!.collapsed = false;

    const observedA = observe(deviceA.windows, deviceA.mapping, "session", "A", origin);
    const observedB = observe(deviceB.windows, deviceB.mapping, "session", "B", origin);

    expect(observedA.mapping.collapsed).toEqual({ g: true });
    expect(observedB.mapping.collapsed).toEqual({ g: false });
    expect(observedA.workspace).toEqual(observedB.workspace);
    expect(JSON.stringify(observedA.workspace)).not.toContain("collapsed");
  });
  it("retains a saved preference while its native group is temporarily absent", () => {
    const { mapping, windows } = setup();
    mapping.collapsed = { g: true };
    windows[0]!.groups = [];

    const result = observe(windows, mapping, "session", "device", origin);

    expect(result.mapping.collapsed).toEqual({ g: true });
  });
  it("prunes local collapsed preferences only after logical deletion", () => {
    const { mapping } = setup();
    mapping.collapsed = { g: true, orphan: false };

    pruneCollapsedGroups(mapping, mapping.observed);
    expect(mapping.collapsed).toEqual({ g: true });

    const deleted = structuredClone(mapping.observed);
    delete deleted.groups.g;
    pruneCollapsedGroups(mapping, deleted);
    expect(mapping.collapsed).toEqual({});
  });
  it("updates collapsed state only from a mapped native group event", () => {
    const { mapping } = setup();
    mapping.collapsed = { g: false };

    expect(updateCollapsedGroup(mapping, 5, true)).toBe(true);
    expect(mapping.collapsed).toEqual({ g: true });
    expect(updateCollapsedGroup(mapping, 5, true)).toBe(false);
    expect(updateCollapsedGroup(mapping, 99, false)).toBe(false);
    expect(mapping.collapsed).toEqual({ g: true });
  });
  it("observes rename/color/membership/ungroup without duplicate create operations", () => {
    const { mapping, windows } = setup();
    Object.assign(windows[0]!.groups![0]!, { title: "New", color: "pink", tabs: [11] });
    const result = observe(windows, mapping, "session", "device", origin);
    expect(diffWorkspace(mapping.observed, result.workspace).map((c) => c.type)).toEqual([
      "group-title",
      "group-color",
      "group-members",
    ]);
    windows[0]!.groups = [];
    const removed = observe(windows, result.mapping, "session", "device", origin);
    expect(diffWorkspace(result.workspace, removed.workspace)).toEqual([
      { type: "group-delete", id: "g" },
    ]);
  });
});
