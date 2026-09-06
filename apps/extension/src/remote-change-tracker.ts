// SPDX-License-Identifier: AGPL-3.0-or-later

/** Retains socket change hints that arrive while a pull or browser reconciliation is in flight. */
export class RemoteChangeTracker {
  private received = 0;
  private applied = 0;

  note() {
    this.received++;
  }

  snapshot() {
    return this.received;
  }

  acknowledge(generation: number) {
    this.applied = Math.max(this.applied, generation);
  }

  get dirty() {
    return this.applied < this.received;
  }
}
