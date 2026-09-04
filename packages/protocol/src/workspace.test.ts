import { describe, expect, it } from "vitest";
import {
  applyOperation,
  type Change,
  emptyWorkspace,
  type LogicalTab,
  parseOperation,
  parseWorkspace,
  tabsIn,
} from "./index";

const tab = (id: string, window = "w", url = "https://example.com/"): LogicalTab => ({
  id,
  window,
  url,
  kind: "web",
  pinned: false,
  index: 0,
  source: "a",
  changed: 0,
});
describe("Canonical workspace reducer", () => {
  it("completes an offline same-sender create then close without resurrecting it", () => {
    const created = applyOperation(
      emptyWorkspace(),
      {
        id: "create",
        sender: "a",
        sequence: 1,
        base: 0,
        changes: [
          { type: "window-create", id: "w", order: 0 },
          { type: "tab-create", tab: tab("t") },
        ],
      },
      1,
    );
    const restored = parseWorkspace(JSON.parse(JSON.stringify(created)));
    const closed = applyOperation(
      restored,
      {
        id: "close",
        sender: "a",
        sequence: 2,
        base: 0,
        changes: [
          { type: "tab-delete", id: "t" },
          { type: "window-delete", id: "w" },
        ],
      },
      2,
    );
    expect(closed.tabs).toEqual({});
    expect(closed.windows).toEqual({});
  });
  it("creates, navigates, orders, pins, moves and closes across windows", () => {
    let state = emptyWorkspace();
    let sequence = 0;
    const apply = (changes: Change[], base = state.revision) => {
      state = applyOperation(
        state,
        { id: crypto.randomUUID(), sender: "a", sequence: ++sequence, base, changes },
        state.revision + 1,
      );
    };
    apply([
      { type: "window-create", id: "w", order: 0 },
      { type: "window-create", id: "w2", order: 1 },
      { type: "tab-create", tab: tab("t") },
      { type: "tab-create", tab: { ...tab("duplicate"), index: 1 } },
    ]);
    expect(Object.keys(state.tabs)).toHaveLength(2);
    apply([
      { type: "tab-navigate", id: "t", kind: "web", url: "https://other.example/", source: "a" },
      { type: "tab-pin", id: "t", pinned: true },
      { type: "tab-move", id: "duplicate", window: "w2", index: 0 },
    ]);
    expect(state.tabs.t?.pinned).toBe(true);
    expect(tabsIn(state, "w2")[0]?.id).toBe("duplicate");
    apply([
      { type: "tab-delete", id: "duplicate" },
      { type: "window-delete", id: "w2" },
    ]);
    expect(state.windows.w2).toBeUndefined();
    expect(parseWorkspace(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
  it("rejects stale destructive changes and uses later accepted navigation", () => {
    let s = emptyWorkspace();
    s = applyOperation(
      s,
      {
        id: "create",
        sender: "a",
        sequence: 1,
        base: 0,
        changes: [
          { type: "window-create", id: "w", order: 0 },
          { type: "tab-create", tab: tab("t") },
        ],
      },
      1,
    );
    s = applyOperation(
      s,
      {
        id: "nav",
        sender: "a",
        sequence: 2,
        base: 1,
        changes: [
          { type: "tab-navigate", id: "t", kind: "web", url: "https://new.example/", source: "a" },
        ],
      },
      2,
    );
    s = applyOperation(
      s,
      {
        id: "stale",
        sender: "b",
        sequence: 1,
        base: 1,
        changes: [{ type: "tab-delete", id: "t" }],
      },
      3,
    );
    expect(s.tabs.t?.url).toBe("https://new.example/");
    const op = {
      id: "last",
      sender: "b",
      sequence: 2,
      base: 1,
      changes: [
        {
          type: "tab-navigate" as const,
          id: "t",
          kind: "web" as const,
          url: "https://last.example/",
          source: "b",
        },
      ],
    };
    s = applyOperation(s, op, 4);
    expect(s.tabs.t?.url).toBe("https://last.example/");
    expect(applyOperation(s, op, 5).tabs).toEqual(s.tabs);
    expect(applyOperation(s, op, 4)).toBe(s);
  });
  it("does not resurrect deleted resources through navigation", () => {
    const s = applyOperation(
      emptyWorkspace(),
      {
        id: "op",
        sender: "a",
        sequence: 1,
        base: 0,
        changes: [
          {
            type: "tab-navigate",
            id: "deleted",
            kind: "web",
            url: "https://example.com/",
            source: "a",
          },
        ],
      },
      1,
    );
    expect(s.tabs).toEqual({});
  });
  it("refuses invalid decrypted URLs, prototype names and unknown operations", () => {
    const op = {
      id: "op",
      sender: "a",
      sequence: 1,
      base: 0,
      changes: [
        { type: "tab-navigate", id: "t", kind: "web", url: "javascript:alert(1)", source: "a" },
      ],
    };
    expect(() => parseOperation(op)).toThrow();
    expect(() =>
      parseOperation({ ...op, changes: [{ type: "window-create", id: "__proto__", order: 0 }] }),
    ).toThrow();
    expect(() => parseOperation({ ...op, changes: [{ type: "inject", id: "t" }] })).toThrow();
  });
});
