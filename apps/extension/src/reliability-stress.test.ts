import { applyOperation, emptyWorkspace, type Operation, type Workspace } from "@relay/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { SimulatedBrowser } from "../../../tests/simulated-browser";
import { browserWindows, capture, reconcile } from "./browser";
import {
  browserWorkspace,
  diffWorkspace,
  type Mapping,
  type ObservedWindow,
  observe,
} from "./browser-model";
import { restoreMapping } from "./workspace-lifecycle";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it.each([1, 20, 70, 200])(
  "converges two %i-tab devices through five synthetic minutes of churn and offline replay",
  async (count) => {
    let now = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let randomState = 37;
    const random = (max: number) => {
      randomState = (randomState * 1664525 + 1013904223) >>> 0;
      return randomState % max;
    };
    const actual: ObservedWindow[] = Array.from({ length: Math.min(5, count) }, (_, i) => ({
      local: i + 1,
      tabs: [],
      groups: [],
    }));
    for (let i = 0; i < count; i++) {
      const w = actual[i % actual.length]!;
      w.tabs.push({
        local: i + 10,
        window: w.local,
        index: w.tabs.length,
        pinned: w.tabs.length === 0,
        incognito: false,
        url: `https://example.com/${i % 11}`,
      });
    }
    for (const w of actual)
      for (let i = 1; i < w.tabs.length; i += 3)
        w.groups!.push({
          local: w.local * 100 + i,
          title: "Group",
          color: "blue",
          collapsed: i % 2 === 1,
          tabs: w.tabs.slice(i, i + 3).map((t) => t.local),
        });
    const initial: Mapping = {
      session: "session",
      windows: {},
      tabs: {},
      expected: [],
      observed: emptyWorkspace(),
    };
    const mapping = observe(actual, initial, "session", "A", "chrome-extension://relay").mapping;
    let canonical = mapping.observed;
    const devices = ["A", "B"].map((id) => ({
      id,
      browser: new SimulatedBrowser(actual),
      mapping: structuredClone(mapping),
      queue: [] as Operation[],
      sequence: 1,
      offline: false,
    }));
    let saves = 0,
      requests = 0;
    const project = (device: (typeof devices)[number]): Workspace =>
      device.queue.reduce(
        (state, op) => applyOperation(state, { ...op, base: state.revision }, state.revision + 1),
        canonical,
      );
    const captureDevice = async (device: (typeof devices)[number]) => {
      device.browser.activate();
      const result = await capture(
        device.mapping,
        device.id,
        device.browser.events.take(now + 5000)!,
        project(device),
      );
      expect(result.shutdown).toBe(false);
      device.mapping = result.mapping;
      if (result.changes.length)
        device.queue.push({
          id: crypto.randomUUID(),
          sender: device.id,
          sequence: device.sequence++,
          base: canonical.revision,
          changes: result.changes,
        });
    };
    const synchronize = async () => {
      for (const device of devices)
        if (!device.offline) {
          for (const operation of device.queue) {
            canonical = applyOperation(canonical, operation, canonical.revision + 1);
            requests++;
          }
          device.queue = [];
        }
      for (const device of devices)
        if (!device.offline) {
          device.browser.activate();
          device.mapping = await reconcile(canonical, device.mapping, device.id, async () => {
            saves++;
          });
          expect(diffWorkspace(browserWorkspace(canonical), device.mapping.observed)).toEqual([]);
          // Complete callbacks from Relay mutations must not create a feedback journal.
          await captureDevice(device);
          expect(device.queue).toEqual([]);
          expect(new Set(Object.values(device.mapping.tabs)).size).toBe(
            Object.keys(canonical.tabs).length,
          );
        }
    };
    const started = performance.now();
    for (let tick = 0; tick < 300; tick++) {
      now += 1000;
      devices[0]!.offline = tick >= 60 && tick < 90;
      devices[1]!.offline = tick >= 150 && tick < 180;
      const device = devices[random(2)]!;
      device.browser.activate();
      const movable = device.browser.tabs.filter((t) => !t.pinned);
      const tab = movable[random(movable.length)];
      const action = random(7);
      if (!tab || action === 0)
        await chrome.tabs.create({
          windowId: random(actual.length) + 1,
          url: `https://example.com/open-${tick % 13}`,
          active: false,
        });
      else if (action === 1) await chrome.tabs.remove(tab.id!);
      else if (action === 2) {
        for (let burst = 0; burst < 3; burst++)
          await chrome.tabs.update(tab.id!, {
            url: `https://example.com/navigation-${tick}-${burst}`,
          });
      } else if (action === 3) {
        await chrome.tabs.update(tab.id!, { pinned: true });
        await chrome.tabs.update(tab.id!, { pinned: false });
      } else if (action === 4)
        await chrome.tabs.move(tab.id!, { windowId: random(actual.length) + 1, index: -1 });
      else if (action === 5) {
        if (tab.groupId >= 0) await chrome.tabs.ungroup(tab.id!);
        else {
          const id = await chrome.tabs.group({ tabIds: [tab.id!] });
          await chrome.tabGroups.update(id, { title: "Updated", color: "green" });
        }
      } else if (tab.groupId >= 0)
        await chrome.tabGroups.update(tab.groupId, { title: `Group ${tick % 5}`, color: "red" });
      await captureDevice(device);
      await synchronize();
      if (tick === 200) {
        // Native IDs change after a replaced session; adopt exact tabs/groups before apply.
        const peer = devices[1]!;
        peer.browser.activate();
        for (const t of peer.browser.tabs) t.id! += 10_000;
        for (const g of peer.browser.groups) {
          for (const t of peer.browser.tabs) if (t.groupId === g.id) t.groupId += 10_000;
          g.id += 10_000;
        }
        peer.browser.session = "restarted";
        const restored = restoreMapping(
          await browserWindows(),
          peer.mapping,
          canonical,
          "restarted",
          peer.id,
          "chrome-extension://relay",
        );
        expect(restored.changes).toEqual([]);
        peer.mapping = restored.mapping;
        await synchronize();
      }
    }
    // Every stress run ends with one normal operation which must reach the other device.
    devices[0]!.browser.activate();
    await chrome.tabs.create({ url: "https://example.com/final-proof", active: false });
    await captureDevice(devices[0]!);
    await synchronize();
    expect(devices[1]!.browser.tabs.some((t) => t.url === "https://example.com/final-proof")).toBe(
      true,
    );
    const mutations = devices.reduce((sum, d) => sum + d.browser.mutations, 0);
    expect(mutations).toBeLessThan(10_000);
    console.info(
      `stress initialTabs=${count} syntheticSeconds=300 elapsedMs=${Math.round(performance.now() - started)} mutations=${mutations} persistenceBoundaries=${saves} acceptedBatches=${requests}`,
    );
  },
  60_000,
);
