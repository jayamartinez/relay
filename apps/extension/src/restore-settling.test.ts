import { emptyWorkspace, type Workspace } from "@relay/protocol";
import { describe, expect, it } from "vitest";
import type { Mapping, ObservedWindow } from "./browser-model";
import {
  RESTORE_COMPLETE_STABLE_MS,
  RESTORE_PARTIAL_GRACE_MS,
  RESTORE_POLL_MS,
  settleBrowserRestore,
} from "./restore-settling";

const origin = "chrome-extension://relay";
function workspace(count: number): Workspace {
  return {
    ...emptyWorkspace(),
    windows: { w: { id: "w", order: 0, changed: 0 } },
    tabs: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `t${index}`,
        {
          id: `t${index}`,
          window: "w",
          index,
          pinned: index % 11 === 0,
          kind: "web" as const,
          url: `https://example.com/${index % 7}`,
          source: "A",
          changed: 0,
        },
      ]),
    ),
  };
}
function mapping(target: Workspace): Mapping {
  return {
    session: "old",
    windows: { 1: "w" },
    tabs: Object.fromEntries(Object.keys(target.tabs).map((id, index) => [10 + index, id])),
    observed: target,
    expected: [],
  };
}
function observed(count: number): ObservedWindow[] {
  return [
    {
      local: 2,
      tabs: Array.from({ length: count }, (_, index) => ({
        local: 100 + index,
        window: 2,
        index,
        pinned: index % 11 === 0,
        incognito: false,
        url: `https://example.com/${index % 7}`,
      })),
    },
  ];
}

describe("native browser restore settling", () => {
  it("settles quickly after a complete restore becomes stable", async () => {
    const target = workspace(20);
    let time = 0;
    let reads = 0;
    const snapshots = [observed(1), observed(10), observed(20)];
    const result = await settleBrowserRestore({
      read: async () => snapshots[Math.min(reads++, snapshots.length - 1)]!,
      previous: mapping(target),
      target,
      session: "new",
      source: "B",
      origin,
      quietAt: () => 0,
      now: () => time,
      wait: async (delay) => {
        time += delay;
      },
    });

    expect(result.complete).toBe(true);
    expect(Object.keys(result.mapping.tabs)).toHaveLength(20);
    expect(time).toBeGreaterThanOrEqual(2 * RESTORE_POLL_MS + RESTORE_COMPLETE_STABLE_MS);
    expect(time).toBeLessThan(RESTORE_PARTIAL_GRACE_MS);
  });

  it("does not treat a briefly stable partial restore as complete", async () => {
    const target = workspace(70);
    let time = 0;
    let reads = 0;
    const result = await settleBrowserRestore({
      read: async () => {
        reads++;
        return observed(12);
      },
      previous: mapping(target),
      target,
      session: "new",
      source: "B",
      origin,
      quietAt: () => 0,
      now: () => time,
      wait: async (delay) => {
        time += delay;
      },
    });

    expect(result.complete).toBe(false);
    expect(time).toBeGreaterThanOrEqual(RESTORE_PARTIAL_GRACE_MS);
    expect(reads).toBeGreaterThan(2);
  });
});
