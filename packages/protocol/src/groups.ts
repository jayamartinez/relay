// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, id, integer, LIMITS, record } from "@relay/shared";
import type { Workspace } from "./index";

export const GROUP_COLORS = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];
export interface LogicalGroup {
  id: string;
  window: string;
  title: string;
  color: GroupColor;
  tabs: string[];
  changed: number;
  writer?: string;
}
export type GroupChange =
  | { type: "group-create"; group: LogicalGroup }
  | { type: "group-delete"; id: string }
  | { type: "group-title"; id: string; title: string }
  | { type: "group-color"; id: string; color: GroupColor }
  | { type: "group-members"; id: string; window: string; tabs: string[] };

export function groupColor(value: unknown): GroupColor {
  assert(GROUP_COLORS.includes(value as GroupColor), "Unsupported tab-group color.");
  return value as GroupColor;
}
export function groupTitle(value: unknown): string {
  assert(typeof value === "string" && value.length <= 256, "Invalid group title.");
  return value;
}
export function groupTabs(value: unknown): string[] {
  assert(Array.isArray(value) && value.length > 0 && value.length <= LIMITS.tabs);
  const tabs = value.map(id);
  assert(new Set(tabs).size === tabs.length, "Duplicate group membership.");
  return tabs;
}
export function parseGroup(value: unknown): LogicalGroup {
  const v = record(value);
  return {
    id: id(v.id),
    window: id(v.window),
    title: groupTitle(v.title),
    color: groupColor(v.color),
    tabs: groupTabs(v.tabs),
    changed: integer(v.changed),
    ...(v.writer === undefined ? {} : { writer: id(v.writer) }),
  };
}
export function groupStructure(group: LogicalGroup) {
  const { changed: _, writer: __, ...structure } = group;
  return structure;
}
export function applyGroupChange(
  state: Workspace,
  change: GroupChange,
  revision: number,
  sender: string,
  base: number,
) {
  state.version = 2;
  const key = change.type === "group-create" ? change.group.id : change.id;
  let group = state.groups[key];
  if (change.type === "group-create") {
    if (
      group ||
      Object.keys(state.groups).length >= LIMITS.tabs ||
      !state.windows[change.group.window]
    )
      return;
    group = state.groups[key] = structuredClone(change.group);
  } else {
    if (!group) return; // Metadata/membership updates cannot resurrect deleted groups.
    if (change.type === "group-delete") {
      if (group.changed <= base || group.writer === sender) delete state.groups[key];
      return; // Ungroup, never delete its tabs.
    }
    if (change.type === "group-title") group.title = change.title;
    if (change.type === "group-color") group.color = change.color;
    if (change.type === "group-members") {
      if (!state.windows[change.window]) return;
      group.window = change.window;
      group.tabs = [...change.tabs];
    }
  }
  group.changed = revision;
  group.writer = sender;
  if (change.type === "group-create" || change.type === "group-members") {
    // The later membership claim wins. Empty groups are pruned after the entire batch.
    for (const other of Object.values(state.groups)) {
      if (other.id === key) continue;
      const remaining = other.tabs.filter((t) => !group!.tabs.includes(t));
      if (remaining.length !== other.tabs.length) {
        other.tabs = remaining;
        other.changed = revision;
        other.writer = sender;
      }
    }
  }
}
export function normalizeGroups(state: Workspace) {
  for (const group of Object.values(state.groups)) {
    group.tabs = group.tabs
      .filter((key) => {
        const tab = state.tabs[key];
        return tab && !tab.pinned && tab.window === group.window;
      })
      .sort((a, b) => state.tabs[a]!.index - state.tabs[b]!.index || a.localeCompare(b));
    if (!group.tabs.length || !state.windows[group.window]) delete state.groups[group.id];
  }
  // Native live groups are contiguous. Repair conflicting concurrent indices deterministically.
  for (const window of new Set(Object.values(state.groups).map((g) => g.window))) {
    const membership = new Map(
      Object.values(state.groups)
        .filter((g) => g.window === window)
        .flatMap((g) => g.tabs.map((t) => [t, g] as const)),
    );
    const ordered = Object.values(state.tabs)
      .filter((t) => t.window === window)
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || a.index - b.index || a.id.localeCompare(b.id),
      );
    const used = new Set<string>();
    let index = 0;
    for (const tab of ordered) {
      if (used.has(tab.id)) continue;
      for (const key of membership.get(tab.id)?.tabs ?? [tab.id]) {
        state.tabs[key]!.index = index++;
        used.add(key);
      }
    }
  }
}
export function validateGroups(state: Workspace) {
  assert(Object.keys(state.groups).length <= LIMITS.tabs);
  assert(
    state.version === 2 || Object.keys(state.groups).length === 0,
    "Groups require workspace schema 2.",
  );
  const used = new Set<string>();
  for (const [key, group] of Object.entries(state.groups)) {
    assert(key === group.id && state.windows[group.window]);
    for (const member of group.tabs) {
      const tab = state.tabs[member];
      assert(
        tab && !tab.pinned && tab.window === group.window && !used.has(member),
        "Invalid group membership.",
      );
      used.add(member);
    }
  }
}
