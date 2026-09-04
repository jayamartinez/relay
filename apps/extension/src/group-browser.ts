// SPDX-License-Identifier: AGPL-3.0-or-later
import { tabsIn, type Workspace } from "@relay/protocol";
import { assert, syncableTab } from "@relay/shared";
import { type Mapping, observedTab, physicalIndex } from "./browser-model";

declare const __DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__: boolean;
export interface BrowserCapabilities {
  tabGroups: boolean;
}
export const groupsEnabled = () =>
  typeof __DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__ === "undefined" ||
  !__DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__;
export function browserCapabilities(): BrowserCapabilities {
  return { tabGroups: groupsAvailable() };
}
export function groupsAvailable(): boolean {
  return (
    groupsEnabled() &&
    typeof chrome !== "undefined" &&
    typeof chrome.tabGroups?.query === "function" &&
    typeof chrome.tabGroups?.get === "function" &&
    typeof chrome.tabGroups?.update === "function" &&
    typeof chrome.tabGroups?.move === "function" &&
    typeof chrome.tabs.group === "function" &&
    typeof chrome.tabs.ungroup === "function"
  );
}
export function requireGroupSupport(workspace: Workspace) {
  assert(
    workspace.version !== 2 || groupsAvailable(),
    "This workspace uses tab groups, which are unavailable in this browser. Local data has been preserved.",
  );
}

// Runs inside the controller's existing serial queue and persisted reconciliation intent.
export async function reconcileGroups(
  target: Workspace,
  mapping: Mapping,
  persist: (mapping: Mapping) => Promise<void>,
) {
  if (!groupsAvailable()) return;
  const localTabs = new Map(
    Object.entries(mapping.tabs).map(([local, sync]) => [sync, Number(local)]),
  );
  const localWindows = new Map(
    Object.entries(mapping.windows).map(([local, sync]) => [sync, Number(local)]),
  );
  const desiredMembership = new Map(
    Object.values(target.groups).flatMap((g) => g.tabs.map((t) => [t, g.id] as const)),
  );
  let live = await chrome.tabs.query({ windowType: "normal" });
  const liveGroups = await chrome.tabGroups.query({});
  const nativeGroups = new Map(liveGroups.map((g) => [g.id, g]));
  const oldMapping = { ...mapping.groups };
  mapping.groups = {};
  mapping.collapsed ??= {};

  // Only tracked tabs are ungrouped, never an unrelated local member or incognito tab.
  for (const tab of live) {
    if (tab.id === undefined || tab.incognito || tab.groupId < 0) continue;
    const logical = mapping.tabs[tab.id];
    if (!logical || !target.tabs[logical]) continue;
    const desired = desiredMembership.get(logical);
    if (!desired || (oldMapping[tab.groupId] && oldMapping[tab.groupId] !== desired))
      await chrome.tabs.ungroup(tab.id);
  }
  for (const group of Object.values(target.groups)) {
    const windowId = localWindows.get(group.window);
    const tabIds = group.tabs
      .map((id) => localTabs.get(id))
      .filter((id): id is number => id !== undefined);
    assert(
      windowId !== undefined && tabIds.length === group.tabs.length,
      "Group members are not available yet.",
    );
    live = await chrome.tabs.query({ windowId });
    const valid = tabIds.every((id) => live.some((t) => t.id === id && !t.incognito && !t.pinned));
    assert(
      valid,
      "Group members changed during reconciliation. Retry when tab dragging has finished.",
    );
    const groupId = Object.entries(oldMapping).find(
      ([local, sync]) => sync === group.id && nativeGroups.has(Number(local)),
    )?.[0];
    let native = groupId === undefined ? undefined : Number(groupId);
    // Never reuse a stale ID or absorb unrelated local tabs after a crash or local regrouping.
    if (
      native !== undefined &&
      (!live.some((t) => t.groupId === native && tabIds.includes(t.id!)) ||
        live.some((t) => t.groupId === native && !tabIds.includes(t.id!)))
    )
      native = undefined;
    if (native === undefined) {
      // Replay after an interrupted create: adopt only the exact desired member set.
      const candidates = [
        ...new Set(
          live.filter((t) => tabIds.includes(t.id!) && t.groupId >= 0).map((t) => t.groupId),
        ),
      ].filter(
        (id) =>
          live.filter((t) => t.groupId === id).length === tabIds.length &&
          live.filter((t) => t.groupId === id).every((t) => tabIds.includes(t.id!)),
      );
      if (candidates.length === 1) native = candidates[0];
    }
    const created = native === undefined;
    const allGrouped =
      native !== undefined &&
      tabIds.every((id) => live.find((t) => t.id === id)?.groupId === native);
    if (!allGrouped)
      native = await chrome.tabs.group({
        tabIds: tabIds as [number, ...number[]],
        ...(native === undefined ? { createProperties: { windowId } } : { groupId: native }),
      });
    assert(native !== undefined);
    mapping.groups[native] = group.id;
    await persist(mapping); // Save returned IDs before metadata calls; replay adopts exact membership.
    // tabs.group does not promise to preserve the order of its tabIds argument when
    // adding tabs to an existing group. Restore member order after grouping itself.
    const members = (await chrome.tabs.query({ groupId: native })).sort(
      (a, b) => a.index - b.index,
    );
    const start = members[0]?.index;
    assert(start !== undefined);
    for (const [index, tabId] of tabIds.entries()) {
      const member = await chrome.tabs.get(tabId);
      if (member.index !== start + index) await chrome.tabs.move(tabId, { index: start + index });
    }
    const current = await chrome.tabGroups.get(native);
    if ((current.title ?? "") !== group.title || current.color !== group.color || created)
      await chrome.tabGroups.update(native, {
        title: group.title,
        color: group.color,
        ...(created && mapping.collapsed[group.id] !== undefined
          ? { collapsed: mapping.collapsed[group.id] }
          : {}),
      });
  }
  // Group/ungroup may shift native indices. Apply group blocks, not individual group members.
  for (const [logicalWindow, windowId] of localWindows) {
    const applied = new Set<string>();
    for (const tab of tabsIn(target, logicalWindow)) {
      const group = desiredMembership.get(tab.id);
      if (group) {
        if (applied.has(group)) continue;
        applied.add(group);
        const native = Number(
          Object.entries(mapping.groups).find(([, sync]) => sync === group)![0],
        );
        const members = await chrome.tabs.query({ groupId: native });
        const strip = await chrome.tabs.query({ windowId });
        const origin = chrome.runtime.getURL("").replace(/\/$/, "");
        const syncable = strip.filter((t) =>
          syncableTab(t.pendingUrl ?? t.url, t.incognito, origin),
        );
        if (syncable.findIndex((t) => t.id === members[0]?.id) !== tab.index)
          await chrome.tabGroups.move(native, {
            windowId,
            index: physicalIndex(
              strip.map(observedTab),
              tab.index,
              members.map((t) => t.id!),
              origin,
            ),
          });
      } else {
        const local = localTabs.get(tab.id);
        if (local === undefined) continue;
        const current = await chrome.tabs.get(local);
        const strip = await chrome.tabs.query({ windowId });
        const origin = chrome.runtime.getURL("").replace(/\/$/, "");
        if (
          strip
            .filter((t) => syncableTab(t.pendingUrl ?? t.url, t.incognito, origin))
            .findIndex((t) => t.id === current.id) !== tab.index
        )
          await chrome.tabs.move(local, {
            index: physicalIndex(strip.map(observedTab), tab.index, local, origin),
          });
      }
    }
  }
}
