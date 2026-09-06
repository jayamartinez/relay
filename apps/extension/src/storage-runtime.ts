// SPDX-License-Identifier: AGPL-3.0-or-later
export class StorageInterruptedError extends Error {
  constructor(cause: unknown) {
    super("Local storage was interrupted. Relay will retry automatically.", { cause });
  }
}
export function storageError(error: DOMException | null) {
  return error?.name === "AbortError" ? new StorageInterruptedError(error) : error;
}
