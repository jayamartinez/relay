import { emptyWorkspace } from "@relay/protocol";
import { expect, it } from "vitest";
import { type Mapping, type ObservedWindow, observe } from "./browser-model";
import { restoreMapping } from "./workspace-lifecycle";

it.each([1, 20, 70, 200])("profiles exact restore of %i tabs across five windows", (count) => {
  const actual: ObservedWindow[] = Array.from({ length: Math.min(count, 5) }, (_, w) => ({
    local: w + 1,
    tabs: [],
    groups: [],
  }));
  for (let i = 0; i < count; i++) {
    const window = actual[i % actual.length]!;
    window.tabs.push({
      local: i + 10,
      window: window.local,
      index: window.tabs.length,
      pinned: window.tabs.length === 0,
      incognito: false,
      url: `https://example.com/${i % 11}`,
    });
  }
  for (const window of actual) {
    for (let start = 1; start < window.tabs.length; start += 3)
      window.groups!.push({
        local: window.local * 100 + start,
        title: "Group",
        color: "blue",
        collapsed: start % 2 === 1,
        tabs: window.tabs.slice(start, start + 3).map((t) => t.local),
      });
  }
  const seed: Mapping = {
    session: "old",
    windows: {},
    tabs: {},
    observed: emptyWorkspace(),
    expected: [],
  };
  const mapping = observe(actual, seed, "old", "device", "chrome-extension://relay").mapping;
  const restored = actual.map((w) => ({
    ...w,
    local: w.local + 1000,
    tabs: w.tabs.map((t) => ({ ...t, local: t.local + 1000, window: w.local + 1000 })),
    groups: w.groups!.map((g) => ({
      ...g,
      local: g.local + 1000,
      tabs: g.tabs.map((t) => t + 1000),
    })),
  }));
  const start = performance.now();
  for (let run = 0; run < 20; run++) {
    const result = restoreMapping(
      restored,
      mapping,
      mapping.observed,
      "new",
      "device",
      "chrome-extension://relay",
    );
    expect(result.changes).toEqual([]);
    expect(new Set(Object.values(result.mapping.tabs)).size).toBe(count);
    expect(new Set(Object.values(result.mapping.groups ?? {}))).toEqual(
      new Set(Object.values(mapping.groups ?? {})),
    );
    expect(result.mapping.collapsed).toEqual(mapping.collapsed);
  }
  console.info(
    `restore tabs=${count} meanMs=${((performance.now() - start) / 20).toFixed(2)} groups=${Object.keys(mapping.groups ?? {}).length}`,
  );
});
