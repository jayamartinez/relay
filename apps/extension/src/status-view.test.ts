import { expect, it } from "vitest";
import type { Status } from "./controller";
import { statusViewKey } from "./status-view";

it("ignores elapsed diagnostic clocks but retains actual connection and presence transitions", () => {
  const state = {
    status: "Live",
    runtime: { lastSocketMessageAge: 10, reconnectBackoff: 0, pendingTasks: 1 },
    devices: [{ online: true }],
  } as Status;
  const next = {
    ...state,
    runtime: { ...state.runtime!, lastSocketMessageAge: 3010, pendingTasks: 2 },
  };
  expect(statusViewKey(next)).toBe(statusViewKey(state));
  expect(statusViewKey({ ...next, status: "Offline" })).not.toBe(statusViewKey(state));
  expect(statusViewKey({ ...next, devices: [] })).not.toBe(statusViewKey(state));
});
