// SPDX-License-Identifier: AGPL-3.0-or-later

/** Serializes extension work without allowing one rejected task to poison later work. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>, failed: (error: unknown) => void): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.then(
      () => undefined,
      (error) => {
        try {
          failed(error);
        } catch {
          // Error reporting must never strand future browser or socket work.
        }
      },
    );
    return next;
  }
}
