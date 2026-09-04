import { describe, expect, it } from "vitest";
import {
  applyOperation,
  type Change,
  emptyWorkspace,
  type LogicalGroup,
  parseOperation,
  parseWorkspace,
} from "./index";

const group: LogicalGroup = {
  id: "g",
  window: "w",
  title: "Research",
  color: "blue",
  tabs: ["a", "b"],
  changed: 0,
};
function scenario() {
  let state = emptyWorkspace();
  const sequences: Record<string, number> = {};
  const apply = (changes: Change[], sender = "device", base = state.revision) => {
    const op = parseOperation({
      id: crypto.randomUUID(),
      sender,
      base,
      sequence: (sequences[sender] = (sequences[sender] ?? 0) + 1),
      changes,
    });
    state = applyOperation(state, op, state.revision + 1);
    return state;
  };
  apply([
    { type: "window-create", id: "w", order: 0 },
    { type: "window-create", id: "w2", order: 1 },
    ...["a", "b", "c"].map(
      (id, index): Change => ({
        type: "tab-create",
        tab: {
          id,
          window: "w",
          index,
          pinned: false,
          kind: "web",
          url: "https://example.com/",
          source: "device",
          changed: 0,
        },
      }),
    ),
  ]);
  return { apply, state: () => state };
}
describe("Versioned live groups", () => {
  it("creates stable groups and synchronizes title/color independently", () => {
    const s = scenario();
    s.apply([{ type: "group-create", group }]);
    s.apply([{ type: "group-title", id: "g", title: "" }]);
    const result = s.apply([{ type: "group-color", id: "g", color: "orange" }], "peer");
    expect(result.groups.g).toMatchObject({
      id: "g",
      title: "",
      color: "orange",
      tabs: ["a", "b"],
    });
    expect(result.version).toBe(2);
    expect(parseWorkspace(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it("ungroups without closing tabs and does not resurrect through late edits", () => {
    const s = scenario();
    s.apply([{ type: "group-create", group }]);
    s.apply([{ type: "group-delete", id: "g" }]);
    const result = s.apply([{ type: "group-title", id: "g", title: "late" }]);
    expect(result.groups).toEqual({});
    expect(Object.keys(result.tabs)).toHaveLength(3);
  });
  it("moves members in/out, between groups, and across windows atomically", () => {
    const s = scenario();
    s.apply([{ type: "group-create", group }]);
    s.apply([{ type: "group-create", group: { ...group, id: "g2", tabs: ["b", "c"] } }]);
    expect(s.state().groups.g?.tabs).toEqual(["a"]);
    const result = s.apply([
      { type: "tab-move", id: "b", window: "w2", index: 1 },
      { type: "tab-move", id: "c", window: "w2", index: 0 },
      { type: "group-members", id: "g2", window: "w2", tabs: ["c", "b"] },
    ]);
    expect(result.groups.g2).toMatchObject({ window: "w2", tabs: ["c", "b"] });
    const ungrouped = s.apply([{ type: "group-members", id: "g2", window: "w2", tabs: ["b"] }]);
    expect(ungrouped.groups.g2?.tabs).toEqual(["b"]);
    expect(ungrouped.tabs.c).toBeDefined();
  });
  it("removes pinned/deleted members and repairs noncontiguous concurrent indices", () => {
    const s = scenario();
    s.apply([{ type: "group-create", group: { ...group, tabs: ["a", "c"] } }]);
    expect(s.state().tabs.c?.index).toBe(1);
    s.apply([{ type: "tab-pin", id: "a", pinned: true }]);
    expect(s.state().groups.g?.tabs).toEqual(["c"]);
    expect(s.apply([{ type: "tab-delete", id: "c" }]).groups).toEqual({});
  });
  it("rejects stale group deletion after a peer edit and deduplicates replay", () => {
    const s = scenario();
    s.apply([{ type: "group-create", group }]);
    const base = s.state().revision;
    s.apply([{ type: "group-title", id: "g", title: "Newer" }], "peer");
    s.apply([{ type: "group-delete", id: "g" }], "device", base);
    expect(s.state().groups.g?.title).toBe("Newer");
    const state = s.state();
    expect(
      applyOperation(
        state,
        {
          id: "replay",
          sender: "peer",
          sequence: 1,
          base,
          changes: [{ type: "group-delete", id: "g" }],
        },
        state.revision + 1,
      ).groups,
    ).toEqual(state.groups);
  });
  it("migrates group-free v1 snapshots, rejects unknown versions and invalid groups", () => {
    const s = scenario();
    const { groups: _, ...legacy } = s.state();
    expect(parseWorkspace(legacy).groups).toEqual({});
    expect(() => parseWorkspace({ ...legacy, version: 3 })).toThrow();
    for (const bad of [
      { ...group, color: "invalid" },
      { ...group, tabs: ["a", "a"] },
      { ...group, tabs: [] },
    ])
      expect(() =>
        parseOperation({
          id: "op",
          sender: "device",
          sequence: 1,
          base: 0,
          changes: [{ type: "group-create", group: bad }],
        }),
      ).toThrow();
    expect(() => parseWorkspace({ ...s.state(), groups: { g: group } })).toThrow();
    expect(() =>
      parseWorkspace({ ...s.state(), version: 2, groups: { g: { ...group, tabs: ["missing"] } } }),
    ).toThrow();
    expect(() =>
      parseWorkspace({
        ...s.state(),
        version: 2,
        groups: { g: group, g2: { ...group, id: "g2" } },
      }),
    ).toThrow();
  });
});
