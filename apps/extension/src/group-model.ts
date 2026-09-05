// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Change, type GroupColor, groupStructure, type Workspace } from "@relay/protocol";
import { canonical } from "@relay/shared";
import type { Mapping, ObservedWindow } from "./browser-model";

export interface ObservedGroup {
  local: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  tabs: number[];
}
export function diffGroups(previous: Workspace, current: Workspace): Change[] {
  const changes: Change[] = [];
  for (const group of Object.values(current.groups ?? {})) {
    const old = previous.groups?.[group.id];
    if (!old) changes.push({ type: "group-create", group: { ...group, changed: 0 } });
    else {
      if (old.title !== group.title)
        changes.push({ type: "group-title", id: group.id, title: group.title });
      if (old.color !== group.color)
        changes.push({ type: "group-color", id: group.id, color: group.color });
      if (old.window !== group.window || canonical(old.tabs) !== canonical(group.tabs))
        changes.push({
          type: "group-members",
          id: group.id,
          window: group.window,
          tabs: group.tabs,
        });
    }
  }
  for (const group of Object.values(previous.groups ?? {}))
    if (!current.groups?.[group.id]) changes.push({ type: "group-delete", id: group.id });
  return changes;
}
export function observeGroups(
  windows: ObservedWindow[],
  next: Mapping,
  previous: Mapping,
  bootstrap: boolean,
) {
  if (!windows.some((w) => w.groups !== undefined)) return;
  next.groups = {};
  // A browser-restored group is authoritative for its current physical state, but a
  // temporarily missing group must not erase the device-local preference needed if
  // reconciliation has to recreate it. Logical deletion is pruned separately once
  // the synchronized workspace no longer contains the group.
  next.collapsed = { ...previous.collapsed };
  next.observed.groups = {};
  const used = new Set<string>();
  for (const window of windows) {
    const logicalWindow = next.windows[window.local];
    if (!logicalWindow) continue;
    for (const group of window.groups ?? []) {
      const tabs = group.tabs
        .map((t) => next.tabs[t])
        .filter((t): t is string => !!t && !next.observed.tabs[t]?.pinned);
      if (!tabs.length) continue;
      let key = !bootstrap ? previous.groups?.[group.local] : undefined;
      if (!key || used.has(key)) {
        // Cross-window native moves may replace the browser ID. Match only an exact,
        // unambiguous set of already-mapped Relay tab IDs, never a title or URL alone.
        const signature = canonical([...tabs].sort());
        const matches = Object.values(previous.observed.groups ?? {}).filter(
          (g) => !used.has(g.id) && canonical([...g.tabs].sort()) === signature,
        );
        key = matches.length === 1 ? matches[0]!.id : crypto.randomUUID();
      }
      used.add(key);
      next.groups[group.local] = key;
      next.collapsed[key] = group.collapsed;
      next.observed.groups[key] = {
        id: key,
        window: logicalWindow,
        title: group.title,
        color: group.color,
        tabs,
        changed: previous.observed.groups?.[key]?.changed ?? 0,
      };
      next.observed.version = 2;
    }
  }
}
export function pruneCollapsedGroups(mapping: Mapping, workspace: Workspace) {
  if (!mapping.collapsed) return;
  for (const id of Object.keys(mapping.collapsed))
    if (!workspace.groups[id]) delete mapping.collapsed[id];
}
export function updateCollapsedGroup(mapping: Mapping, local: number, collapsed: boolean): boolean {
  const logical = mapping.groups?.[local];
  if (!logical || mapping.collapsed?.[logical] === collapsed) return false;
  mapping.collapsed ??= {};
  mapping.collapsed[logical] = collapsed;
  return true;
}
export function groupMutationValue(change: Extract<Change, { type: "group-create" }>) {
  return canonical({ type: change.type, group: groupStructure(change.group) });
}
