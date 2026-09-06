import { emptyWorkspace, type LogicalTab } from "@relay/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserEvents } from "./browser-events";
import { expectation, type Mapping, navigationCircuit } from "./browser-model";
import {
  committedNavigation,
  expectNavigation,
  remoteNavigationEvent,
  skipRemoteNavigation,
} from "./navigation";

const tab: LogicalTab = {
  id: "tab",
  window: "window",
  kind: "web",
  url: "https://example.com/search?q=test",
  pinned: false,
  index: 0,
  source: "peer",
  changed: 1,
};
const mapping = (): Mapping => ({
  session: "session",
  tabs: { 7: "tab" },
  windows: { 1: "window" },
  observed: emptyWorkspace(),
  expected: [],
});
afterEach(() => vi.useRealTimers());
describe("Persistent navigation ownership", () => {
  it("does not pause explicit rapid address-bar navigation after a remote apply", () => {
    const m = mapping();
    expectNavigation(m, tab, 7, undefined, "remote-op");
    m.expected.push(expectation({ type: "tab-create", tab }, "remote-op"));
    for (let i = 0; i < 5; i++) {
      const url = `https://example.com/typed-${i}`;
      committedNavigation(m, 7, url, "typed", ["from_address_bar"]);
      expect(
        navigationCircuit(
          [{ type: "tab-navigate", id: tab.id, kind: "web", url, source: "local" }],
          m,
        ),
      ).toBe(false);
    }
  });
  it("skips an already normalized target URL before making a browser update", () => {
    expect(skipRemoteNavigation(mapping(), tab, 7, tab.url)).toBe(true);
    expect(
      skipRemoteNavigation(
        mapping(),
        { ...tab, url: "https://example.com/" },
        7,
        "https://example.com",
      ),
    ).toBe(true);
  });
  it("suppresses multiple asynchronous initialization/loading/complete callbacks after reload", () => {
    vi.useFakeTimers();
    const m = mapping();
    expectNavigation(m, tab, 7, "https://example.com/old", "remote-op");
    const restored = JSON.parse(JSON.stringify(m)) as Mapping;
    for (const value of ["https://example.com/old", tab.url!, tab.url!, tab.url!]) {
      vi.advanceTimersByTime(250);
      expect(remoteNavigationEvent(restored, 7, value, false)).toBe(true);
    }
    expect(remoteNavigationEvent(restored, 7, tab.url!, true)).toBe(true);
    expect(skipRemoteNavigation(restored, tab, 7, tab.url)).toBe(true);
  });
  it("does not feed a receiver-side redirect back or reload its canonical URL on every pull", () => {
    vi.useFakeTimers();
    const m = mapping();
    expectNavigation(m, tab, 7, "https://example.com/old", "remote-op");
    committedNavigation(m, 7, "https://example.com/redirect", "link", ["server_redirect"]);
    expect(remoteNavigationEvent(m, 7, "https://example.com/redirect", true)).toBe(true);
    vi.advanceTimersByTime(16_000);
    expect(skipRemoteNavigation(m, tab, 7, "https://example.com/redirect")).toBe(true);
    expect(remoteNavigationEvent(m, 7, "https://example.com/user-navigation", true)).toBe(false);
    expect(
      skipRemoteNavigation(
        m,
        { ...tab, url: "https://example.com/new-canonical" },
        7,
        "https://example.com/redirect",
      ),
    ).toBe(false);
  });
  it("bounds ownership by TTL when no completion callback arrives", () => {
    vi.useFakeTimers();
    const m = mapping();
    expectNavigation(m, tab, 7, undefined, "remote-op");
    vi.advanceTimersByTime(15_001);
    expect(remoteNavigationEvent(m, 7, "https://example.com/user", false)).toBe(false);
  });
  it("does not swallow a new user navigation or Back during an owned navigation", () => {
    const m = mapping();
    expectNavigation(m, tab, 7, "https://example.com/old", "remote-op");
    expect(remoteNavigationEvent(m, 7, "https://example.com/user", false)).toBe(false);
    committedNavigation(m, 7, "https://example.com/old", "link", ["forward_back"]);
    expect(remoteNavigationEvent(m, 7, "https://example.com/old", true)).toBe(false);
  });
  it("keeps two healthy devices out of the reversal circuit after an owned remote apply", () => {
    const m = mapping();
    expectNavigation(m, tab, 7, "https://example.com/old", "remote-op");
    for (const value of [tab.url!, tab.url!, tab.url!]) {
      expect(remoteNavigationEvent(m, 7, value, true)).toBe(true);
      expect(
        navigationCircuit(
          [{ type: "tab-navigate", id: tab.id, kind: "web", url: value, source: "remote" }],
          m,
        ),
      ).toBe(false);
    }
  });
  it("coalesces rapid A/B/C URL events into the latest per-tab value", () => {
    const events = new BrowserEvents();
    events.navigation(7, "A", false, 0);
    events.navigation(7, "B", false, 60);
    events.navigation(7, "C", true, 100);
    expect(events.take(299)).toBeUndefined();
    expect([...events.take(300)!.navigations]).toEqual([[7, { url: "C", complete: true }]]);
  });
  it("does not let a noisy second tab starve the first settled navigation", () => {
    const events = new BrowserEvents();
    events.navigation(7, "settled", true, 0);
    events.committed(8, "A", "link", [], 100);
    events.committed(8, "B", "link", [], 190);
    const first = events.take(200)!;
    expect([...first.navigations.keys()]).toEqual([7]);
    expect([...first.unsettledTabs!]).toEqual([8]);
    expect(events.readyAt).toBe(390);
    expect([...events.take(390)!.navigations.keys()]).toEqual([8]);
  });
  it("waits for redirect commit metadata instead of emitting a provisional loading URL", () => {
    const events = new BrowserEvents();
    events.navigation(7, "https://example.com/redirect", false, 0);
    expect(events.take(300)!.unsettledTabs?.has(7)).toBe(true);
    events.committed(7, "https://example.com/redirect", "link", ["server_redirect"], 400);
    expect(events.take(599)).toBeUndefined();
    expect(events.take(600)!.commits?.get(7)?.qualifiers).toEqual(["server_redirect"]);
  });
});
