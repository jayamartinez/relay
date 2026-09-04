// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Change, LogicalTab, Workspace } from "@relay/protocol";
import { canonical, isWeb, syncableTab } from "@relay/shared";
import type { BrowserBatch } from "./browser-events";
import { diffGroups, groupMutationValue, type ObservedGroup, observeGroups } from "./group-model";
export interface ObservedTab {
  local: number;
  window: number;
  index: number;
  pinned: boolean;
  url?: string;
  incognito: boolean;
}
export interface ObservedWindow {
  local: number;
  tabs: ObservedTab[];
  groups?: ObservedGroup[];
}
export function observedTab(tab: chrome.tabs.Tab): ObservedTab {
  return {
    local: tab.id!,
    window: tab.windowId,
    index: tab.index,
    pinned: tab.pinned,
    incognito: tab.incognito,
    url: tab.pendingUrl ?? tab.url,
  };
}
export interface Mapping {
  session: string;
  windows: Record<string, string>;
  tabs: Record<string, string>;
  observed: Workspace;
  expected: Expectation[];
  reversals?: Record<string, number[]>;
  groups?: Record<string, string>;
  collapsed?: Record<string, boolean>;
  ignoredWindows?: number[];
  navigation?: Record<string, NavigationReceipt>;
}
export interface NavigationReceipt {
  local: number;
  resource: string;
  operationId: string;
  expectedUrl: string;
  previousUrl?: string;
  expires: number;
  completeAt?: number;
  settledUrl?: string;
  redirects?: string[];
  source?: "USER" | "REMOTE";
}
export function navigationKey(tab: Pick<LogicalTab, "kind" | "url">): string {
  return tab.kind === "newtab" ? "newtab" : (tab.url ?? "");
}
export function navigationCircuit(changes: Change[], mapping: Mapping, now = Date.now()): boolean {
  const reversals = mapping.reversals ?? {};
  for (const key of Object.keys(reversals)) {
    reversals[key] = reversals[key]!.filter((time) => time > now - 60_000);
    if (!reversals[key]?.length) delete reversals[key];
  }
  let tripped = false;
  for (const change of changes) {
    if (change.type !== "tab-navigate") continue;
    if (
      !mapping.expected.some(
        (e) =>
          e.resource === change.id &&
          e.expires > now &&
          ["tab-create", "tab-navigate"].includes(e.mutation),
      )
    )
      continue;
    const times = reversals[change.id] ?? [];
    times.push(now);
    reversals[change.id] = times.slice(-3);
    if (times.length >= 3) tripped = true;
  }
  mapping.reversals = reversals;
  return tripped;
}
export interface Expectation {
  operationId: string;
  resource: string;
  mutation: string;
  value: string;
  expires: number;
}
function mutationValue(change: Change): string {
  if (change.type === "group-create") return groupMutationValue(change);
  if (change.type === "tab-navigate") {
    const { source: _, ...browserFields } = change;
    return canonical(browserFields);
  }
  if (change.type === "tab-create") {
    const { source: _, changed: __, writer: ___, ...browserFields } = change.tab;
    return canonical({ type: change.type, tab: browserFields });
  }
  return canonical(change);
}
export function expectation(change: Change, operationId: string): Expectation {
  const resource = changeResource(change);
  return {
    operationId,
    resource,
    mutation: change.type,
    value: mutationValue(change),
    expires: Date.now() + 15_000,
  };
}
export function suppress(change: Change, expected: Expectation[]): boolean {
  const resource = changeResource(change);
  return expected.some(
    (e) =>
      e.expires > Date.now() &&
      e.resource === resource &&
      e.mutation === change.type &&
      e.value === mutationValue(change),
  );
}
function changeResource(change: Change): string {
  if (change.type === "tab-create") return change.tab.id;
  if (change.type === "group-create") return change.group.id;
  return change.id;
}
export function diffWorkspace(previous: Workspace, current: Workspace): Change[] {
  const changes: Change[] = [];
  for (const window of Object.values(current.windows))
    if (!previous.windows[window.id])
      changes.push({ type: "window-create", id: window.id, order: window.order });
  for (const tab of Object.values(current.tabs)) {
    const old = previous.tabs[tab.id];
    if (!old) {
      changes.push({ type: "tab-create", tab: { ...tab, changed: 0 } });
      continue;
    }
    if (tab.kind !== old.kind || tab.url !== old.url)
      changes.push({
        type: "tab-navigate",
        id: tab.id,
        kind: tab.kind,
        ...(tab.url ? { url: tab.url } : {}),
        source: tab.source,
      });
    if (tab.window !== old.window || tab.index !== old.index)
      changes.push({ type: "tab-move", id: tab.id, window: tab.window, index: tab.index });
    if (tab.pinned !== old.pinned)
      changes.push({ type: "tab-pin", id: tab.id, pinned: tab.pinned });
  }
  for (const tab of Object.values(previous.tabs))
    if (!current.tabs[tab.id] && current.windows[tab.window])
      changes.push({ type: "tab-delete", id: tab.id });
  changes.push(
    ...diffGroups(previous, current).filter(
      (c) => c.type !== "group-delete" || !!current.windows[previous.groups[c.id]!.window],
    ),
  );
  for (const window of Object.values(previous.windows))
    if (!current.windows[window.id]) changes.push({ type: "window-delete", id: window.id });
  return changes;
}
function fingerprint(tab: Pick<LogicalTab, "kind" | "url" | "pinned">): string {
  return canonical({ kind: tab.kind, url: tab.url, pinned: tab.pinned });
}
export function observe(
  windows: ObservedWindow[],
  mapping: Mapping,
  session: string,
  source: string,
  ownOrigin: string,
): { workspace: Workspace; mapping: Mapping; bootstrap: boolean } {
  const bootstrap = mapping.session !== session;
  const next = structuredClone(mapping);
  next.session = session;
  next.windows = {};
  next.tabs = {};
  const result: Workspace = { ...mapping.observed, windows: {}, tabs: {} };
  const usedWindows = new Set<string>();
  const usedTabs = new Set<string>();
  for (const window of windows) {
    if (mapping.ignoredWindows?.includes(window.local)) continue;
    const classified = window.tabs
      .sort((a, b) => a.index - b.index)
      .flatMap((tab) => {
        const kind = syncableTab(tab.url, tab.incognito, ownOrigin);
        return kind ? [{ tab, kind }] : [];
      });
    if (!classified.length && !mapping.windows[window.local]) continue;
    let windowId = !bootstrap ? mapping.windows[String(window.local)] : undefined;
    if (bootstrap) {
      const signature = classified
        .map((c) => fingerprint({ ...c.kind, pinned: c.tab.pinned }))
        .join("|");
      const matches = Object.values(mapping.observed.windows).filter(
        (w) =>
          !usedWindows.has(w.id) &&
          Object.values(mapping.observed.tabs)
            .filter((t) => t.window === w.id)
            .sort((a, b) => a.index - b.index)
            .map(fingerprint)
            .join("|") === signature,
      );
      // Full hydration uses restoreMapping's richer matching. Even this fallback must
      // reuse canonical window IDs on a replaced session, never mint restart windows.
      if (matches.length === 1) windowId = matches[0]?.id;
      windowId ??= Object.values(mapping.observed.windows)
        .sort((a, b) => a.order - b.order)
        .find((w) => !usedWindows.has(w.id))?.id;
      if (!windowId) continue;
    }
    windowId ??= crypto.randomUUID();
    usedWindows.add(windowId);
    next.windows[String(window.local)] = windowId;
    result.windows[windowId] = {
      id: windowId,
      order: mapping.observed.windows[windowId]?.order ?? Object.keys(result.windows).length,
      changed: mapping.observed.revision,
    };
    for (const [index, { tab, kind }] of classified.entries()) {
      let tabId = !bootstrap ? mapping.tabs[String(tab.local)] : undefined;
      if (!tabId && mapping.observed.windows[windowId]) {
        // Window + kind/URL + pin + ordered duplicate occurrence; never URL alone.
        const candidate = Object.values(mapping.observed.tabs)
          .filter(
            (t) =>
              t.window === windowId &&
              !usedTabs.has(t.id) &&
              fingerprint(t) === fingerprint({ ...kind, pinned: tab.pinned }),
          )
          .sort((a, b) => a.index - b.index)[0];
        if (candidate) tabId = candidate.id;
      }
      tabId ??= crypto.randomUUID();
      usedTabs.add(tabId);
      next.tabs[String(tab.local)] = tabId;
      const old = mapping.observed.tabs[tabId];
      result.tabs[tabId] = {
        id: tabId,
        window: windowId,
        ...kind,
        pinned: tab.pinned,
        index,
        source: old && old.kind === kind.kind && old.url === kind.url ? old.source : source,
        changed: old?.changed ?? 0,
      };
    }
  }
  next.windows = Object.fromEntries(
    Object.entries(next.windows).filter(([, v]) => usedWindows.has(v)),
  );
  next.tabs = Object.fromEntries(Object.entries(next.tabs).filter(([, v]) => usedTabs.has(v)));
  next.observed = result;
  observeGroups(windows, next, mapping, bootstrap);
  next.expected = next.expected.filter((e) => e.expires > Date.now());
  return { workspace: result, mapping: next, bootstrap };
}
export function targetUrl(tab: LogicalTab, ownOrigin: string): string | undefined {
  if (isWeb(tab.kind)) return tab.url;
  void ownOrigin;
  return undefined;
}
export function authorizedChanges(
  changes: Change[],
  previous: Mapping,
  actual: ObservedWindow[],
  evidence: BrowserBatch,
): Change[] {
  if (!actual.length) return []; // Final-window closure is a device lifetime event, never a reset.
  const tabs = new Map(actual.flatMap((w) => w.tabs).map((t) => [t.local, t]));
  return changes.filter((change) => {
    if (change.type === "window-delete")
      return Object.entries(previous.windows).some(
        ([local, logical]) => logical === change.id && evidence.closingWindows.has(Number(local)),
      );
    if (change.type !== "tab-delete") return true;
    return Object.entries(previous.tabs).some(([local, logical]) => {
      if (logical !== change.id) return false;
      const tab = tabs.get(Number(local));
      return (
        evidence.closedTabs.has(Number(local)) ||
        (tab?.url !== undefined && !syncableTab(tab.url, tab.incognito))
      );
    });
  });
}
export function physicalIndex(
  tabs: ObservedTab[],
  desired: number,
  moving: number | number[] | undefined,
  ownOrigin: string,
): number {
  const removed = new Set(Array.isArray(moving) ? moving : moving === undefined ? [] : [moving]);
  const others = tabs.filter((t) => !removed.has(t.local)).sort((a, b) => a.index - b.index);
  const syncable = others.filter((t) => syncableTab(t.url, t.incognito, ownOrigin));
  const anchor = syncable[desired];
  // Native moves remove the moving tab before inserting; calculate on that remaining strip.
  if (anchor) return others.indexOf(anchor);
  const last = syncable.at(-1);
  return last ? others.indexOf(last) + 1 : others.length;
}
