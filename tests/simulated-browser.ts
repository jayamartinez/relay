import { vi } from "vitest";
import { BrowserEvents } from "../apps/extension/src/browser-events";
import type { ObservedWindow } from "../apps/extension/src/browser-model";

/** Stateful browser adapter for deterministic controller/model stress tests. */
export class SimulatedBrowser {
  events = new BrowserEvents();
  tabs: chrome.tabs.Tab[] = [];
  groups: chrome.tabGroups.TabGroup[] = [];
  windows = new Set<number>();
  session = "session";
  mutations = 0;
  queries = 0;
  private nextId = 1000;
  constructor(actual: ObservedWindow[]) {
    for (const window of actual) {
      this.windows.add(window.local);
      for (const tab of window.tabs)
        this.tabs.push({
          id: tab.local,
          windowId: window.local,
          index: tab.index,
          pinned: tab.pinned,
          incognito: false,
          url: tab.url,
          frozen: false,
          lastAccessed: 0,
          active: false,
          highlighted: false,
          selected: false,
          discarded: false,
          autoDiscardable: true,
          groupId: window.groups?.find((g) => g.tabs.includes(tab.local))?.local ?? -1,
        });
      for (const group of window.groups ?? [])
        this.groups.push({
          id: group.local,
          windowId: window.local,
          title: group.title,
          color: group.color,
          collapsed: group.collapsed,
          shared: false,
        });
    }
  }
  private strip(windowId: number) {
    return this.tabs.filter((t) => t.windowId === windowId).sort((a, b) => a.index - b.index);
  }
  private clean() {
    this.groups = this.groups.filter((g) => this.tabs.some((t) => t.groupId === g.id));
    for (const window of this.windows)
      this.strip(window).forEach((t, i) => {
        t.index = i;
      });
  }
  private get(id: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  }
  private move(id: number, windowId: number, index: number) {
    const tab = this.get(id);
    const others = this.strip(windowId).filter((t) => t.id !== id);
    if (tab.windowId !== windowId) tab.groupId = -1;
    tab.windowId = windowId;
    const pinned = others.filter((t) => t.pinned).length;
    const requested = index < 0 ? others.length : index;
    others.splice(tab.pinned ? Math.min(requested, pinned) : Math.max(requested, pinned), 0, tab);
    others.forEach((t, i) => {
      t.index = i;
    });
    this.clean();
    return structuredClone(tab);
  }
  activate() {
    const changed = () => {
      this.mutations++;
      this.events.changed();
    };
    vi.stubGlobal("chrome", {
      runtime: { getURL: () => "chrome-extension://relay/" },
      storage: { session: { get: async () => ({ browserSession: this.session }) } },
      windows: {
        getAll: async () => {
          this.queries++;
          return [...this.windows].map((id) => ({
            id,
            incognito: false,
            tabs: structuredClone(this.strip(id)),
          }));
        },
        create: async ({ tabId, url }: { tabId?: number; url?: string }) => {
          const id = this.nextId++;
          this.windows.add(id);
          if (tabId !== undefined) this.move(tabId, id, 0);
          else await chrome.tabs.create({ windowId: id, url });
          changed();
          return { id, tabs: structuredClone(this.strip(id)) };
        },
      },
      tabs: {
        get: async (id: number) => {
          this.queries++;
          return structuredClone(this.get(id));
        },
        query: async (q: { windowId?: number; groupId?: number }) => {
          this.queries++;
          return structuredClone(
            this.tabs
              .filter(
                (t) =>
                  (q.windowId === undefined || t.windowId === q.windowId) &&
                  (q.groupId === undefined || t.groupId === q.groupId),
              )
              .sort((a, b) => a.windowId - b.windowId || a.index - b.index),
          );
        },
        create: async (p: chrome.tabs.CreateProperties) => {
          const id = this.nextId++,
            windowId = p.windowId ?? [...this.windows][0]!;
          this.tabs.push({
            id,
            windowId,
            index: this.strip(windowId).length,
            pinned: p.pinned ?? false,
            incognito: false,
            url: p.url ?? "about:blank",
            frozen: false,
            lastAccessed: 0,
            active: false,
            highlighted: false,
            selected: false,
            discarded: false,
            autoDiscardable: true,
            groupId: -1,
          });
          const tab = this.move(id, windowId, p.index ?? -1);
          changed();
          return tab;
        },
        update: async (id: number, p: chrome.tabs.UpdateProperties) => {
          const tab = this.get(id);
          if (p.url !== undefined) {
            tab.url = p.url;
            this.events.navigation(id, p.url, true);
          }
          if (p.pinned !== undefined) {
            tab.pinned = p.pinned;
            if (p.pinned) tab.groupId = -1;
            this.move(
              id,
              tab.windowId,
              p.pinned ? 0 : this.strip(tab.windowId).filter((t) => t.pinned).length,
            );
          }
          changed();
          return structuredClone(tab);
        },
        move: async (id: number, p: chrome.tabs.MoveProperties) => {
          const tab = this.move(id, p.windowId ?? this.get(id).windowId, p.index);
          changed();
          return tab;
        },
        remove: async (ids: number | number[]) => {
          for (const id of Array.isArray(ids) ? ids : [ids]) {
            const tab = this.get(id);
            this.tabs = this.tabs.filter((t) => t.id !== id);
            this.events.removed(id, tab.windowId, false);
          }
          this.clean();
          changed();
        },
        group: async (p: {
          tabIds: number[];
          groupId?: number;
          createProperties?: { windowId: number };
        }) => {
          const id = p.groupId ?? this.nextId++,
            first = this.get(p.tabIds[0]!);
          if (!this.groups.some((g) => g.id === id))
            this.groups.push({
              id,
              windowId: p.createProperties?.windowId ?? first.windowId,
              title: "",
              color: "grey",
              collapsed: false,
              shared: false,
            });
          for (const tab of p.tabIds) this.get(tab).groupId = id;
          changed();
          return id;
        },
        ungroup: async (ids: number | number[]) => {
          for (const id of Array.isArray(ids) ? ids : [ids]) this.get(id).groupId = -1;
          this.clean();
          changed();
        },
      },
      tabGroups: {
        query: async () => {
          this.queries++;
          return structuredClone(this.groups);
        },
        get: async (id: number) => {
          this.queries++;
          const group = this.groups.find((g) => g.id === id);
          if (!group) throw new Error(`No group with id: ${id}`);
          return structuredClone(group);
        },
        update: async (id: number, p: chrome.tabGroups.UpdateProperties) => {
          const group = this.groups.find((g) => g.id === id)!;
          Object.assign(group, p);
          changed();
          return structuredClone(group);
        },
        move: async (id: number, p: chrome.tabGroups.MoveProperties) => {
          const members = this.tabs
            .filter((t) => t.groupId === id)
            .sort((a, b) => a.index - b.index);
          for (const [i, tab] of members.entries()) {
            this.move(tab.id!, p.windowId ?? tab.windowId, p.index + i);
            this.get(tab.id!).groupId = id;
          }
          changed();
          return structuredClone(this.groups.find((g) => g.id === id));
        },
      },
    });
  }
}
