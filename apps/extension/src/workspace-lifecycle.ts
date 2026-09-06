// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Change, emptyWorkspace, tabsIn, type Workspace } from "@relay/protocol";
import { canonical, syncableTab } from "@relay/shared";
import { diffWorkspace, type Mapping, type ObservedWindow, observe } from "./browser-model";

const signature = (kind: { kind: string; url?: string }, pinned: boolean) =>
  canonical({ ...kind, pinned });
const tabSignature = (tab: Workspace["tabs"][string]) =>
  signature({ kind: tab.kind, ...(tab.url ? { url: tab.url } : {}) }, tab.pinned);
function localTabs(window: ObservedWindow, origin: string) {
  return [...window.tabs]
    .sort((a, b) => a.index - b.index)
    .flatMap((tab) => {
      const kind = syncableTab(tab.url, tab.incognito, origin);
      return kind ? [{ tab, kind }] : [];
    });
}
export function restoreMapping(
  actual: ObservedWindow[],
  previous: Mapping,
  target: Workspace,
  session: string,
  source: string,
  origin: string,
): { mapping: Mapping; changes: Change[] } {
  const seed = structuredClone(previous);
  seed.session = session;
  seed.windows = {};
  seed.tabs = {};
  seed.ignoredWindows = [];
  // Match against both the last local observation and current canonical state. A restored
  // old URL can still identify a tab whose canonical destination changed while offline.
  seed.observed = structuredClone(target);
  const candidates = Object.values(target.windows).sort((a, b) => a.order - b.order);
  const portableByWindow = new Map(actual.map((w) => [w.local, localTabs(w, origin)]));
  const indexed = new Map(
    candidates.map((w) => {
      const tabs = tabsIn(target, w.id);
      const current = tabs.map(tabSignature);
      const prior = tabsIn(previous.observed, w.id).map(tabSignature);
      const bySignature = new Map<string, string[]>();
      // Reverse once so pop() consumes duplicate occurrences in canonical order.
      for (const tab of [...tabs].reverse()) {
        const old = previous.observed.tabs[tab.id];
        for (const value of new Set([tabSignature(tab), ...(old ? [tabSignature(old)] : [])])) {
          const matches = bySignature.get(value) ?? [];
          matches.push(tab.id);
          bySignature.set(value, matches);
        }
      }
      return [
        w.id,
        {
          tabs,
          exact: new Set([canonical(current), canonical(prior)]),
          overlap: new Set([...current, ...prior]),
          bySignature,
        },
      ] as const;
    }),
  );
  const usedWindows = new Set<string>();
  const usedTabs = new Set<string>();
  const assign = (window: ObservedWindow, key: string) => {
    seed.windows[window.local] = key;
    usedWindows.add(key);
  };
  for (const window of actual) {
    const key = previous.session === session ? previous.windows[window.local] : undefined;
    if (key && target.windows[key] && !usedWindows.has(key)) assign(window, key);
  }
  for (const window of actual.filter((w) => !seed.windows[w.local])) {
    const local = portableByWindow.get(window.local)!.map((t) => signature(t.kind, t.tab.pinned));
    if (!local.length) continue;
    const matches = candidates.filter(
      (w) => !usedWindows.has(w.id) && indexed.get(w.id)!.exact.has(canonical(local)),
    );
    if (matches.length === 1) assign(window, matches[0]!.id);
  }
  for (const window of actual.filter((w) => !seed.windows[w.local])) {
    const local = portableByWindow.get(window.local)!.map((t) => signature(t.kind, t.tab.pinned));
    const scores = candidates
      .filter((w) => !usedWindows.has(w.id))
      .map((w) => ({
        id: w.id,
        score: local.filter((value) => indexed.get(w.id)!.overlap.has(value)).length,
      }))
      .sort((a, b) => b.score - a.score);
    if (scores[0]?.score && scores[0].score > (scores[1]?.score ?? 0)) assign(window, scores[0].id);
  }
  // Remaining physical windows represent remaining canonical windows by stable window order.
  // In particular, 1+1 reuses the current window even after a partial/native fresh restore.
  for (const window of actual.filter((w) => !seed.windows[w.local])) {
    const match = candidates.find((w) => !usedWindows.has(w.id));
    if (match) assign(window, match.id);
    else seed.ignoredWindows.push(window.local); // Never invent a window ID during resume.
  }
  for (const window of actual) {
    const key = seed.windows[window.local];
    if (!key) continue;
    for (const { tab, kind } of portableByWindow.get(window.local)!) {
      let logical = previous.session === session ? previous.tabs[tab.local] : undefined;
      if (!logical || !target.tabs[logical] || usedTabs.has(logical)) {
        const value = signature(kind, tab.pinned);
        const matches = indexed.get(key)!.bySignature.get(value);
        do {
          logical = matches?.pop();
        } while (logical && usedTabs.has(logical));
      }
      if (logical) {
        seed.tabs[tab.local] = logical;
        usedTabs.add(logical);
      }
    }
    const portable = portableByWindow.get(window.local)!;
    const canonicalTabs = indexed.get(key)!.tabs;
    if (
      portable.length === 1 &&
      portable[0]!.kind.kind === "newtab" &&
      !seed.tabs[portable[0]!.tab.local]
    ) {
      const candidate = canonicalTabs.find((tab) => !usedTabs.has(tab.id));
      if (candidate) {
        seed.tabs[portable[0]!.tab.local] = candidate.id;
        usedTabs.add(candidate.id);
      }
    }
    if (portable.length === canonicalTabs.length) {
      for (const [index, entry] of portable.entries()) {
        if (seed.tabs[entry.tab.local]) continue;
        const candidate = canonicalTabs[index];
        if (candidate && !usedTabs.has(candidate.id)) {
          seed.tabs[entry.tab.local] = candidate.id;
          usedTabs.add(candidate.id);
        }
      }
    }
  }
  // Existing numeric tab IDs not in canonical state can be retained only within this session.
  // Observe allocates new IDs for genuinely unmatched local tabs, never for mapped windows.
  const observed = observe(actual, seed, session, source, origin).mapping;
  const changes: Change[] = [];
  const appended = new Map<string, number>();
  for (const tab of Object.values(observed.observed.tabs))
    if (!target.tabs[tab.id]) {
      const index = (indexed.get(tab.window)?.tabs.length ?? 0) + (appended.get(tab.window) ?? 0);
      appended.set(tab.window, (appended.get(tab.window) ?? 0) + 1);
      changes.push({ type: "tab-create", tab: { ...tab, index } });
    }
  // Missing resources at startup are not deletion evidence. Canonical state fills them in.
  return { mapping: observed, changes };
}

export function initialMerge(
  actual: ObservedWindow[],
  previous: Mapping,
  canonicalState: Workspace,
  session: string,
  source: string,
  origin: string,
) {
  const seed = structuredClone(previous);
  seed.session = session;
  const local = actual.filter((w) => localTabs(w, origin).length || actual.length === 1);
  const canonicalWindows = Object.values(canonicalState.windows);
  if (local.length === 1 && canonicalWindows.length === 1)
    seed.windows[local[0]!.local] = canonicalWindows[0]!.id;
  else {
    // Exact whole-window occurrence matching is safe for multi-window imports. Otherwise
    // preserve genuinely separate pre-existing windows as distinct logical windows.
    const used = new Set<string>();
    for (const window of local) {
      const value = canonical(
        localTabs(window, origin).map((t) => signature(t.kind, t.tab.pinned)),
      );
      const matches = canonicalWindows.filter(
        (w) =>
          !used.has(w.id) && canonical(tabsIn(canonicalState, w.id).map(tabSignature)) === value,
      );
      if (matches.length === 1) {
        seed.windows[window.local] = matches[0]!.id;
        used.add(matches[0]!.id);
      }
    }
  }
  const result = observe(actual, seed, session, source, origin);
  const changes = diffWorkspace(emptyWorkspace(), result.workspace).filter(
    (c) => c.type !== "window-create" || !canonicalState.windows[c.id],
  );
  for (const change of changes)
    if (change.type === "tab-create") {
      change.tab.index += tabsIn(canonicalState, change.tab.window).length;
    }
  return { mapping: result.mapping, changes };
}
