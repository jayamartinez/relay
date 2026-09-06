// SPDX-License-Identifier: AGPL-3.0-or-later

/** Serializes extension work without allowing one rejected task to poison later work. */
export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  pending = 0;

  run<T>(task: () => Promise<T>, failed: (error: unknown) => void): Promise<T> {
    this.pending++;
    const next = this.tail.then(task).finally(() => {
      this.pending--;
    });
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
