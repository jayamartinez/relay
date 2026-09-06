import { emptyWorkspace, type Workspace } from "@relay/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mapping } from "./browser-model";
import { groupsAvailable, reconcileGroups, requireGroupSupport } from "./group-browser";

afterEach(() => vi.unstubAllGlobals());
it("keeps group workspaces fail-closed when browser capability is absent", () => {
  vi.stubGlobal("__DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__", false);
  const legacy = emptyWorkspace();
  expect(() => requireGroupSupport(legacy)).not.toThrow();
  const grouped = { ...legacy, version: 2 as const };
  const before = structuredClone(grouped);
  expect(() => requireGroupSupport(grouped)).toThrow("unavailable in this browser");
  expect(grouped).toEqual(before);
});
it("does not attempt group sync when a browser lacks supported APIs", () => {
  vi.stubGlobal("__DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__", false);
  vi.stubGlobal("chrome", { tabs: {} });
  expect(groupsAvailable()).toBe(false);
  expect(() => requireGroupSupport({ ...emptyWorkspace(), version: 2 })).toThrow();
});

function groupedWorkspace(): Workspace {
  return {
    ...emptyWorkspace(),
    version: 2,
    windows: { w: { id: "w", order: 0, changed: 0 } },
    tabs: Object.fromEntries(
      ["a", "b"].map((id, index) => [
        id,
        {
          id,
          window: "w",
          index,
          pinned: false,
          kind: "web" as const,
          url: `https://example.com/${id}`,
          source: "device",
          changed: 0,
        },
      ]),
    ),
    groups: {
      g: {
        id: "g",
        window: "w",
        title: "Work",
        color: "green",
        tabs: ["a", "b"],
        changed: 0,
      },
    },
  };
}

function mapping(workspace: Workspace, nativeGroup?: number, collapsed = true): Mapping {
  return {
    session: "session",
    windows: { 1: "w" },
    tabs: { 10: "a", 11: "b" },
    ...(nativeGroup === undefined ? {} : { groups: { [nativeGroup]: "g" } }),
    collapsed: { g: collapsed },
    observed: structuredClone(workspace),
    expected: [],
  };
}

function browser(nativeGroup: number | undefined, collapsed: boolean) {
  const tabs = [10, 11].map((id, index) => ({
    id,
    windowId: 1,
    index,
    pinned: false,
    incognito: false,
    groupId: nativeGroup ?? -1,
    url: `https://example.com/${index ? "b" : "a"}`,
  }));
  const groups =
    nativeGroup === undefined
      ? []
      : [{ id: nativeGroup, windowId: 1, title: "Work", color: "green", collapsed }];
  const update = vi.fn(async (id: number, changes: Record<string, unknown>) => {
    const native = groups.find((group) => group.id === id);
    if (!native) throw new Error("Missing native group in test browser.");
    Object.assign(native, changes);
    return native;
  });
  const group = vi.fn(async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
    const id = groupId ?? 50;
    if (!groups.some((candidate) => candidate.id === id))
      groups.push({ id, windowId: 1, title: "", color: "grey", collapsed: false });
    for (const tab of tabs) if (tabIds.includes(tab.id)) tab.groupId = id;
    return id;
  });
  vi.stubGlobal("__DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__", false);
  vi.stubGlobal("chrome", {
    runtime: { getURL: () => "chrome-extension://relay/" },
    tabs: {
      query: vi.fn(async (query: { windowId?: number; groupId?: number }) =>
        tabs.filter(
          (tab) =>
            (query.windowId === undefined || tab.windowId === query.windowId) &&
            (query.groupId === undefined || tab.groupId === query.groupId),
        ),
      ),
      get: vi.fn(async (id: number) => tabs.find((tab) => tab.id === id)),
      move: vi.fn(async () => undefined),
      group,
      ungroup: vi.fn(async (ids: number | number[]) => {
        const selected = new Set(Array.isArray(ids) ? ids : [ids]);
        for (const tab of tabs) if (selected.has(tab.id)) tab.groupId = -1;
      }),
    },
    tabGroups: {
      query: vi.fn(async () => groups),
      get: vi.fn(async (id: number) => groups.find((candidate) => candidate.id === id)),
      update,
      move: vi.fn(async () => undefined),
    },
  });
  return { group, update };
}

describe("device-local group collapse reconciliation", () => {
  it.each([true, false])(
    "leaves an adopted browser-restored group collapsed=%s",
    async (collapsed) => {
      const workspace = groupedWorkspace();
      const api = browser(50, collapsed);
      const local = mapping(workspace, 5, collapsed);

      await reconcileGroups(workspace, local, async () => undefined);

      expect(local.groups).toEqual({ 50: "g" });
      expect(api.group).not.toHaveBeenCalled();
      expect(api.update).not.toHaveBeenCalled();
    },
  );
  it("reapplies the saved local state when a group must be recreated", async () => {
    const workspace = groupedWorkspace();
    const api = browser(undefined, false);
    const local = mapping(workspace, undefined, true);

    await reconcileGroups(workspace, local, async () => undefined);

    expect(local.groups).toEqual({ 50: "g" });
    expect(api.group).toHaveBeenCalledOnce();
    expect(api.update).toHaveBeenCalledWith(
      50,
      expect.objectContaining({ title: "Work", color: "green", collapsed: true }),
    );
  });
  it("adopts an exact rebuilt group without expanding it", async () => {
    const workspace = groupedWorkspace();
    const api = browser(50, true);
    const local = mapping(workspace, 5, true);

    await reconcileGroups(workspace, local, async () => undefined);

    expect(local.groups).toEqual({ 50: "g" });
    expect(api.group).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  });
});
