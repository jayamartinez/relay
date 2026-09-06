// SPDX-License-Identifier: AGPL-3.0-or-later
export type Lifecycle =
  | "UNINITIALIZED"
  | "LOADING_LOCAL_STATE"
  | "WAITING_FOR_BROWSER_RESTORE"
  | "FETCHING_CANONICAL_STATE"
  | "RECONCILING"
  | "LIVE"
  | "STOPPED";
export const NAVIGATION_DELAY = 200;
export const WINDOW_CLOSE_DELAY = 1_200;
export interface BrowserBatch {
  closedTabs: Set<number>;
  closingWindows: Set<number>;
  createdWindows: Set<number>;
  navigations: Map<number, { url: string; complete: boolean }>;
  unsettledTabs?: Set<number>;
  commits?: Map<number, { url: string; transition: string; qualifiers: string[] }>;
}
const batch = (): BrowserBatch => ({
  closedTabs: new Set(),
  closingWindows: new Set(),
  createdWindows: new Set(),
  navigations: new Map(),
});

// Event evidence is separate from workspace observation. Absence alone never authorizes deletion.
export class BrowserEvents {
  pending = batch();
  due = 0;
  closeDue = 0;
  generation = 0;
  private navigationDue = new Map<number, number>();
  private committedUrls = new Map<number, string>();
  private commits = new Map<number, { url: string; transition: string; qualifiers: string[] }>();
  changed(now = Date.now()) {
    this.generation++;
    this.due = now + NAVIGATION_DELAY;
  }
  removed(tab: number, window: number, isWindowClosing: boolean, now = Date.now()) {
    this.committedUrls.delete(tab);
    this.commits.delete(tab);
    this.navigationDue.delete(tab);
    this.pending.navigations.delete(tab);
    if (isWindowClosing) this.windowRemoved(window, now);
    else {
      this.pending.closedTabs.add(tab);
      this.changed(now);
    }
  }
  windowRemoved(window: number, now = Date.now()) {
    this.pending.closingWindows.add(window);
    this.changed(now);
    this.closeDue = now + WINDOW_CLOSE_DELAY;
  }
  windowCreated(window: number, now = Date.now()) {
    this.pending.createdWindows.add(window);
    this.changed(now);
  }
  navigation(tab: number, url: string, complete: boolean, now = Date.now()) {
    this.pending.navigations.set(tab, { url, complete });
    if (complete || this.committedUrls.get(tab) === url)
      this.navigationDue.set(tab, now + NAVIGATION_DELAY);
    else this.navigationDue.delete(tab); // Wait for commit/complete, not a provisional loading URL.
    this.generation++;
  }
  committed(tab: number, url: string, transition: string, qualifiers: string[], now = Date.now()) {
    this.committedUrls.set(tab, url);
    this.commits.set(tab, { url, transition, qualifiers });
    this.navigation(tab, url, false, now);
  }
  get readyAt() {
    const earliest = Math.min(this.due || Infinity, ...this.navigationDue.values());
    return Math.max(earliest === Infinity ? 0 : earliest, this.closeDue);
  }
  get quietAt() {
    return Math.max(this.due, this.closeDue, ...this.navigationDue.values());
  }
  get closing() {
    return this.pending.closingWindows.size > 0;
  }
  summary() {
    return {
      generation: this.generation,
      closedTabs: this.pending.closedTabs.size,
      closingWindows: this.pending.closingWindows.size,
      createdWindows: this.pending.createdWindows.size,
      navigations: this.pending.navigations.size,
      pending:
        this.pending.closedTabs.size +
        this.pending.closingWindows.size +
        this.pending.createdWindows.size +
        this.pending.navigations.size,
    };
  }
  take(now = Date.now()): BrowserBatch | undefined {
    if (now < this.readyAt) return;
    const value = batch();
    if (this.due <= now) {
      value.closedTabs = this.pending.closedTabs;
      value.closingWindows = this.pending.closingWindows;
      value.createdWindows = this.pending.createdWindows;
      this.pending.closedTabs = new Set();
      this.pending.closingWindows = new Set();
      this.pending.createdWindows = new Set();
      this.due = 0;
      this.closeDue = 0;
    }
    for (const [tab, deadline] of this.navigationDue) {
      if (deadline > now) continue;
      value.navigations.set(tab, this.pending.navigations.get(tab)!);
      this.pending.navigations.delete(tab);
      this.navigationDue.delete(tab);
    }
    value.unsettledTabs = new Set(this.pending.navigations.keys());
    value.commits = new Map();
    for (const tab of value.navigations.keys()) {
      const commit = this.commits.get(tab);
      if (commit) value.commits.set(tab, commit);
      this.commits.delete(tab);
    }
    return value;
  }
  clear() {
    this.pending = batch();
    this.due = 0;
    this.closeDue = 0;
    this.navigationDue.clear();
    this.commits.clear();
    this.committedUrls.clear();
  }
  restore(value: BrowserBatch) {
    // Re-arm consumed evidence after a failed browser query, retaining newer input.
    this.due = Math.max(this.due, Date.now() + NAVIGATION_DELAY);
    for (const [tab, commit] of value.commits ?? [])
      if (!this.commits.has(tab)) this.commits.set(tab, commit);
    for (const key of value.closedTabs) this.pending.closedTabs.add(key);
    for (const key of value.closingWindows) this.pending.closingWindows.add(key);
    for (const key of value.createdWindows) this.pending.createdWindows.add(key);
    for (const [key, event] of value.navigations)
      if (!this.pending.navigations.has(key)) {
        this.pending.navigations.set(key, event);
        this.navigationDue.set(key, Date.now());
      }
  }
}
