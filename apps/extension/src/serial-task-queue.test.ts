import { describe, expect, it, vi } from "vitest";
import { SerialTaskQueue } from "./serial-task-queue";

describe("SerialTaskQueue", () => {
  it("continues after a rejected task and records the failure", async () => {
    const queue = new SerialTaskQueue();
    const calls: number[] = [];
    const failed = vi.fn();

    const first = queue.run(async () => {
      calls.push(1);
      throw new Error("expected test failure");
    }, failed);
    const second = queue.run(async () => calls.push(2), failed);
    const third = queue.run(async () => calls.push(3), failed);

    await expect(first).rejects.toThrow("expected test failure");
    await Promise.all([second, third]);
    expect(calls).toEqual([1, 2, 3]);
    expect(failed).toHaveBeenCalledOnce();
  });

  it("continues even if failure reporting itself throws", async () => {
    const queue = new SerialTaskQueue();
    const later = vi.fn();
    void queue.run(
      async () => Promise.reject(new Error("first")),
      () => {
        throw new Error("reporter");
      },
    );

    await queue.run(
      async () => later(),
      () => undefined,
    );
    expect(later).toHaveBeenCalledOnce();
  });
});
