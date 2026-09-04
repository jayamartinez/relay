import { emptyWorkspace, type LogicalTab } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import {
  diffWorkspace,
  expectation,
  type Mapping,
  navigationCircuit,
  observe,
  suppress,
  targetUrl,
} from "./browser-model";

const tab: LogicalTab = {
  id: "t",
  window: "w",
  kind: "web",
  url: "https://example.com/",
  pinned: false,
  index: 0,
  source: "a",
  changed: 0,
};
function mapping(): Mapping {
  return {
    session: "session",
    windows: { 1: "w" },
    tabs: { 10: "t", 11: "duplicate" },
    expected: [],
    observed: {
      ...emptyWorkspace(),
      windows: { w: { id: "w", order: 0, changed: 0 } },
      tabs: { t: tab, duplicate: { ...tab, id: "duplicate", index: 1 } },
    },
  };
}
describe("Browser identity and loop prevention", () => {
  it("trips a bounded circuit on repeated remote-navigation reversals", () => {
    const m = mapping();
    const now = Date.now();
    const change = {
      type: "tab-navigate" as const,
      id: "t",
      kind: "web" as const,
      url: "https://redirect.example/",
      source: "a",
    };
    m.expected = [
      expectation({ ...change, url: "https://requested.example/", source: "b" }, "remote"),
    ];
    expect(navigationCircuit([change], m, now)).toBe(false);
    expect(navigationCircuit([change], m, now + 1)).toBe(false);
    expect(navigationCircuit([change], m, now + 2)).toBe(true);
    expect(navigationCircuit([change], m, now + 61_000)).toBe(false);
  });
  it("remaps duplicate URLs by occurrence after restart", () => {
    const m = mapping();
    const result = observe(
      [
        {
          local: 2,
          tabs: [
            { local: 20, window: 2, url: tab.url, index: 0, pinned: false, incognito: false },
            { local: 21, window: 2, url: tab.url, index: 1, pinned: false, incognito: false },
          ],
        },
      ],
      m,
      "new-session",
      "a",
      "chrome-extension://relay",
    );
    expect(result.mapping.tabs).toEqual({ 20: "t", 21: "duplicate" });
    expect(diffWorkspace(m.observed, result.workspace)).toEqual([]);
  });
  it("reuses the canonical window rather than minting another during bootstrap", () => {
    const result = observe(
      [
        {
          local: 2,
          tabs: [
            {
              local: 20,
              window: 2,
              url: "https://different.example/",
              index: 0,
              pinned: false,
              incognito: false,
            },
          ],
        },
      ],
      mapping(),
      "new-session",
      "a",
      "chrome-extension://relay",
    );
    expect(result.mapping.windows[2]).toBe("w");
    expect(result.bootstrap).toBe(true);
  });
  it("suppresses exact remote mutations, not unrelated user navigation", () => {
    const change = {
      type: "tab-navigate" as const,
      id: "t",
      kind: "web" as const,
      url: "https://remote.example/",
      source: "b",
    };
    const expected = [expectation(change, "op")];
    expect(suppress(change, expected)).toBe(true);
    expect(suppress({ ...change, url: "https://user.example/" }, expected)).toBe(false);
    expected[0]!.expires = 0;
    expect(suppress(change, expected)).toBe(false);
  });
  it("normalizes delayed event bursts to no changes after applying remote state", () => {
    const m = mapping();
    const actual = [
      {
        local: 1,
        tabs: [
          { local: 10, window: 1, url: tab.url, index: 0, pinned: false, incognito: false },
          { local: 11, window: 1, url: tab.url, index: 1, pinned: false, incognito: false },
        ],
      },
    ];
    let current = m;
    for (let i = 0; i < 10; i++) {
      const result = observe(actual, current, "session", "a", "chrome-extension://relay");
      expect(diffWorkspace(current.observed, result.workspace)).toEqual([]);
      current = result.mapping;
    }
  });
  it("omits legacy placeholders and incognito entirely", () => {
    const m = mapping();
    m.observed.tabs.t = { ...tab, kind: "local-file", url: undefined };
    delete m.observed.tabs.duplicate;
    delete m.tabs[11];
    const actual = [
      {
        local: 1,
        tabs: [
          {
            local: 10,
            window: 1,
            url: "chrome-extension://relay/placeholder.html#t",
            index: 0,
            pinned: false,
            incognito: false,
          },
          {
            local: 12,
            window: 1,
            url: "https://secret.example/",
            index: 1,
            pinned: false,
            incognito: true,
          },
        ],
      },
    ];
    const result = observe(actual, m, "session", "b", "chrome-extension://relay");
    expect(Object.keys(result.workspace.tabs)).toHaveLength(0);
    expect(targetUrl(m.observed.tabs.t!, "chrome-extension://relay")).toBeUndefined();
  });
});
