// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BrowserRaceReason } from "./diagnostics";

export interface ReconcileGuardContext {
  boundary: string;
  logicalId?: string;
  mutation?: "create" | "navigate";
}

export class BrowserRuntimeRaceError extends Error {
  readonly category = "BROWSER_RUNTIME_RACE";

  constructor(
    message = "Browser changed while Relay was reconciling.",
    options?: ErrorOptions & { reason?: BrowserRaceReason; boundary?: string; browserId?: number },
  ) {
    super(message, options);
    this.name = "BrowserRuntimeRaceError";
    this.reason = options?.reason;
    this.boundary = options?.boundary;
    this.browserId = options?.browserId;
  }
  readonly reason?: BrowserRaceReason;
  readonly boundary?: string;
  readonly browserId?: number;
}

const EXPECTED_CHROME_RACE =
  /^(No tab with id:|No window with id:|No current window|No group with id:|Tabs cannot be edited right now|Cannot move a tab once|Cannot access a chrome:\/\/ URL|The tab was closed|The window was closed)/i;

export function asBrowserRuntimeRace(error: unknown): BrowserRuntimeRaceError | undefined {
  if (error instanceof BrowserRuntimeRaceError) return error;
  if (error instanceof Error && EXPECTED_CHROME_RACE.test(error.message))
    return new BrowserRuntimeRaceError(undefined, {
      cause: error,
      reason: browserRuntimeRaceReason(error.message),
      boundary: "chromium_api",
      browserId: browserRuntimeRaceBrowserId(error.message),
    });
  return undefined;
}

function browserRuntimeRaceBrowserId(message: string): number | undefined {
  const value = /(?:tab|window|group) with id:\s*(\d+)/i.exec(message)?.[1];
  return value === undefined ? undefined : Number(value);
}

export function browserRuntimeRaceReason(message: string): BrowserRaceReason {
  if (/^No tab with id:/i.test(message)) return "missing_tab";
  if (/^No window with id:/i.test(message)) return "missing_window";
  if (/^No group with id:/i.test(message)) return "missing_group";
  if (/^Tabs cannot be edited right now|^Cannot move a tab once/i.test(message))
    return "tab_not_editable";
  if (/^The tab was closed|^The window was closed/i.test(message)) return "window_closing";
  return "unknown_browser_runtime_error";
}
