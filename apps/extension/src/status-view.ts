// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Status } from "./controller";
export function statusViewKey(state: Status): string {
  // Clock-derived diagnostics change on every read without a state transition.
  const runtime = state.runtime
    ? {
        ...state.runtime,
        reconnectBackoff: undefined,
        lastSocketMessageAge: undefined,
        pendingTasks: undefined,
      }
    : undefined;
  return JSON.stringify({ ...state, runtime });
}
