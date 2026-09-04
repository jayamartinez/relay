// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Change, replicatedWorkspace, tabsIn, type Workspace } from "@relay/protocol";
import { classifyTab, isWeb, syncableTab } from "@relay/shared";
import type { BrowserBatch } from "./browser-events";
import {
  authorizedChanges,
  diffWorkspace,
  expectation,
  type Mapping,
  navigationKey,
  type ObservedWindow,
  observe,
  observedTab,
  physicalIndex,
  suppress,
  targetUrl,
} from "./browser-model";
import { trace } from "./diagnostics";
import { groupsAvailable, reconcileGroups, requireGroupSupport } from "./group-browser";
import {
  committedNavigation,
  expectNavigation,
  remoteNavigationEvent,
  skipRemoteNavigation,
} from "./navigation";
export const ownOrigin = () => chrome.runtime.getURL("").replace(/\/$/, "");
async function windowTabs(windowId: number) {
  return (await chrome.tabs.query({ windowId }))
    .filter((t) => t.id !== undefined && !t.incognito)
    .map(observedTab);
}
export async function browserWindows(): Promise<ObservedWindow[]> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const groups = groupsAvailable() ? await chrome.tabGroups.query({}) : undefined;
  return windows
    .filter((w) => !w.incognito && w.id !== undefined)
    .map((w) => ({
      local: w.id as number,
      ...(groups === undefined
        ? {}
        : {
            groups: groups
              .filter((g) => g.windowId === w.id)
              .map((g) => ({
                local: g.id,
                title: (g.title ?? "").slice(0, 256),
                color: g.color,
                collapsed: g.collapsed,
                tabs: (w.tabs ?? [])
                  .filter((t) => t.groupId === g.id && t.id !== undefined && !t.incognito)
                  .sort((a, b) => a.index - b.index)
                  .map((t) => t.id!),
              })),
          }),
      tabs: (w.tabs ?? []).filter((t) => t.id !== undefined && !t.incognito).map(observedTab),
    }));
}
export async function sessionId(): Promise<string> {
  const value = await chrome.storage.session.get("browserSession");
  if (typeof value.browserSession === "string") return value.browserSession;
  const session = crypto.randomUUID();
  await chrome.storage.session.set({ browserSession: session });
  return session;
}
export async function capture(
  mapping: Mapping,
  source: string,
  evidence: BrowserBatch,
  canonical: Workspace,
): Promise<{ mapping: Mapping; changes: Change[]; bootstrap: boolean; shutdown: boolean }> {
  const actual = await browserWindows();
  if (!actual.length) return { mapping, changes: [], bootstrap: false, shutdown: true };
  const seed = structuredClone(mapping);
  const ownedCommits = new Set<number>();
  for (const [tab, commit] of evidence.commits ?? [])
    if (committedNavigation(seed, tab, commit.url, commit.transition, commit.qualifiers))
      ownedCommits.add(tab);
  seed.ignoredWindows = (seed.ignoredWindows ?? []).filter(
    (id) => !evidence.createdWindows.has(id),
  );
  // A disappearing unmapped window is never sufficient evidence for a new import.
  for (const window of actual)
    if (!seed.windows[window.local] && !evidence.createdWindows.has(window.local))
      seed.ignoredWindows.push(window.local);
  // A query can already expose the NEXT provisional URL while we process a prior
  // committed event. Observe the settled event URL, never that racing pendingUrl.
  for (const tab of actual.flatMap((window) => window.tabs)) {
    const prior = mapping.observed.tabs[mapping.tabs[tab.local] ?? ""];
    if (!prior) continue;
    const event = evidence.navigations.get(tab.local);
    tab.url = event?.url ?? (prior.kind === "newtab" ? "about:blank" : prior.url);
  }
  const result = observe(actual, seed, await sessionId(), source, ownOrigin());
  // Keep unsettled tabs at their prior observed URL while independently settled tabs advance.
  for (const local of evidence.unsettledTabs ?? []) {
    const logical = result.mapping.tabs[local];
    const prior = logical ? mapping.observed.tabs[logical] : undefined;
    const current = logical ? result.workspace.tabs[logical] : undefined;
    if (prior && current) {
      current.kind = prior.kind;
      current.url = prior.url;
    }
  }
  const changes = authorizedChanges(
    diffWorkspace(mapping.observed, result.workspace),
    mapping,
    actual,
    evidence,
  )
    .filter(
      (change) =>
        (change.type === "tab-navigate" || !suppress(change, mapping.expected)) &&
        (!result.bootstrap ||
          (change.type !== "tab-delete" &&
            change.type !== "window-delete" &&
            change.type !== "group-delete")),
    )
    .filter((change) => {
      if (change.type !== "tab-navigate") return true;
      trace("USER", "TAB_NAVIGATE", "DETECTED", change.id);
      const local = Number(
        Object.entries(result.mapping.tabs).find(([, id]) => id === change.id)?.[0],
      );
      const receipt = seed.navigation?.[change.id];
      const duplicate =
        canonical.tabs[change.id] &&
        navigationKey(canonical.tabs[change.id]!) === navigationKey(change);
      const owned = remoteNavigationEvent(
        seed,
        local,
        change.url ?? "about:blank",
        evidence.navigations.get(local)?.complete ?? false,
      );
      if (
        duplicate ||
        owned ||
        ownedCommits.has(local) ||
        (receipt &&
          receipt.settledUrl === navigationKey(change) &&
          receipt.expectedUrl === navigationKey(canonical.tabs[change.id] ?? change))
      ) {
        trace(
          owned ? "REMOTE" : "USER",
          "TAB_NAVIGATE",
          owned ? "SUPPRESS" : "SKIP_DUPLICATE",
          change.id,
        );
        return false;
      }
      return true;
    });
  result.mapping.navigation = seed.navigation;
  return { mapping: result.mapping, changes, bootstrap: result.bootstrap, shutdown: false };
}
export async function workspaceStats() {
  const windows = await browserWindows();
  let web = 0;
  let local = 0;
  for (const w of windows)
    for (const t of w.tabs) {
      const c = classifyTab(t.url, false, ownOrigin());
      if (c) {
        if (isWeb(c.kind) || c.kind === "newtab") web++;
        else local++;
      }
    }
  return { windows: windows.length, tabs: web, local };
}
export async function reconcile(
  target: Workspace,
  mapping: Mapping,
  source: string,
  persist: (mapping: Mapping) => Promise<void>,
  allowed: () => boolean = () => true,
): Promise<Mapping> {
  target = replicatedWorkspace(target);
  requireGroupSupport(target);
  const next = structuredClone(mapping);
  const operationId = crypto.randomUUID();
  next.expected.push(
    ...diffWorkspace(mapping.observed, target).map((c) => expectation(c, operationId)),
  );
  // Intent is durable before calling Chrome. A terminated worker can replay this target.
  await persist(next);
  const actual = await browserWindows();
  if (!actual.length || !allowed())
    throw new Error("Browser reconciliation interrupted by window closure.");
  next.collapsed ??= {};
  for (const window of actual)
    for (const group of window.groups ?? []) {
      const key = next.groups?.[group.local];
      if (key) next.collapsed[key] = group.collapsed;
    }
  await persist(next);
  const actualTabs = new Map(actual.flatMap((w) => w.tabs).map((t) => [t.local, t]));
  const localWindows = new Map(
    Object.entries(next.windows).map(([local, sync]) => [sync, Number(local)]),
  );
  const localTabs = new Map(
    Object.entries(next.tabs).map(([local, sync]) => [sync, Number(local)]),
  );
  for (const window of Object.values(target.windows).sort((a, b) => a.order - b.order)) {
    if (!allowed()) throw new Error("Browser reconciliation interrupted by window closure.");
    const desired = tabsIn(target, window.id);
    if (!desired.length) continue;
    let local = localWindows.get(window.id);
    if (local === undefined || !actual.some((w) => w.local === local)) {
      const first = desired[0];
      if (!first) continue;
      const existingFirst = localTabs.get(first.id);
      const reusableFirst = existingFirst !== undefined && actualTabs.has(existingFirst);
      const created = await chrome.windows.create({
        focused: false,
        type: "normal",
        ...(reusableFirst ? { tabId: existingFirst } : { url: targetUrl(first, ownOrigin()) }),
      });
      if (!created || created.id === undefined) throw new Error("Browser did not create a window.");
      local = created.id;
      next.windows[String(local)] = window.id;
      localWindows.set(window.id, local);
      const tab = created.tabs?.[0];
      if (tab?.id !== undefined) {
        next.tabs[String(tab.id)] = first.id;
        localTabs.set(first.id, tab.id);
        if (!reusableFirst) {
          expectNavigation(next, first, tab.id, undefined, operationId);
          trace("RECONCILE", "TAB_CREATE", "APPLY", first.id, operationId);
        }
      }
      await persist(next);
    }
    for (const tab of desired) {
      if (!allowed()) throw new Error("Browser reconciliation interrupted by window closure.");
      let localTab = localTabs.get(tab.id);
      let live =
        localTab === undefined ? undefined : await chrome.tabs.get(localTab).catch(() => undefined);
      if (!live) {
        const current = await windowTabs(local);
        const created: chrome.tabs.Tab = await chrome.tabs.create({
          windowId: local,
          url: targetUrl(tab, ownOrigin()),
          active: false,
          pinned: tab.pinned,
          index: physicalIndex(current, tab.index, undefined, ownOrigin()),
        });
        if (created.id === undefined) throw new Error("Browser did not create a tab.");
        localTab = created.id;
        live = created;
        next.tabs[String(localTab)] = tab.id;
        localTabs.set(tab.id, created.id);
        expectNavigation(next, tab, created.id, undefined, operationId);
        trace("RECONCILE", "TAB_CREATE", "APPLY", tab.id, operationId);
        await persist(next);
      }
      if (localTab === undefined || !live || live.incognito) continue;
      if (!skipRemoteNavigation(next, tab, localTab, live.pendingUrl ?? live.url)) {
        expectNavigation(next, tab, localTab, live.pendingUrl ?? live.url, operationId);
        await persist(next);
        trace("REMOTE", "TAB_NAVIGATE", "APPLY", tab.id, operationId);
        await chrome.tabs.update(localTab, { url: targetUrl(tab, ownOrigin()) ?? "about:blank" });
      }
      if (live.pinned !== tab.pinned) await chrome.tabs.update(localTab, { pinned: tab.pinned });
      const current = await windowTabs(local);
      const logicalIndex = current
        .filter((t) => syncableTab(t.url, t.incognito, ownOrigin()))
        .findIndex((t) => t.local === localTab);
      if (live.windowId !== local || logicalIndex !== tab.index)
        await chrome.tabs.move(localTab, {
          windowId: local,
          index: physicalIndex(current, tab.index, localTab, ownOrigin()),
        });
    }
  }
  for (const [localText, logical] of Object.entries(next.tabs)) {
    if (target.tabs[logical]) continue;
    const local = Number(localText);
    const live = actualTabs.get(local);
    const previous = mapping.observed.tabs[logical];
    // Never close an untracked, incognito, or identity-mismatched tab.
    if (live && previous && !live.incognito) {
      const classified = classifyTab(live.url);
      const placeholder = live.url === `${ownOrigin()}/placeholder.html#${logical}`;
      const safe =
        placeholder ||
        (classified?.kind === previous.kind &&
          (!isWeb(previous.kind) || classified.url === previous.url));
      if (safe) await chrome.tabs.remove(local);
    }
    delete next.tabs[localText];
  }
  for (const [local, logical] of Object.entries(next.windows))
    if (!target.windows[logical]) delete next.windows[local];
  // Legacy Relay placeholders are extension-owned and can be removed safely. Real
  // file/browser/extension tabs are never closed as part of this policy migration.
  for (const tab of actualTabs.values())
    if (
      tab.url?.startsWith(`${ownOrigin()}/placeholder.html#`) &&
      (await chrome.tabs.get(tab.local).catch(() => undefined))
    )
      await chrome.tabs.remove(tab.local);
  for (const key of Object.keys(next.navigation ?? {}))
    if (!target.tabs[key]) delete next.navigation![key];
  // No windows.remove: it could close unrelated local/extension tabs. Chrome closes an emptied window.
  await reconcileGroups(target, next, persist);
  next.observed = target;
  const observed = observe(await browserWindows(), next, await sessionId(), source, ownOrigin());
  await persist(observed.mapping);
  return observed.mapping;
}
