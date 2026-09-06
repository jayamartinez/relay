import { describe, expect, it } from "vitest";
import { RemoteChangeTracker } from "./remote-change-tracker";

describe("RemoteChangeTracker", () => {
  it("retains a change notification that arrives during an in-flight pull", () => {
    const tracker = new RemoteChangeTracker();
    tracker.note();
    const pulling = tracker.snapshot();
    tracker.note();
    tracker.acknowledge(pulling);
    expect(tracker.dirty).toBe(true);

    tracker.acknowledge(tracker.snapshot());
    expect(tracker.dirty).toBe(false);
  });
});
