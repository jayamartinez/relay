// SPDX-License-Identifier: AGPL-3.0-or-later

export class BrowserRuntimeRaceError extends Error {
  readonly category = "BROWSER_RUNTIME_RACE";

  constructor(message = "Browser changed while Relay was reconciling.", options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserRuntimeRaceError";
  }
}

const EXPECTED_CHROME_RACE =
  /^(No tab with id:|No window with id:|Tabs cannot be edited right now|Cannot move a tab once|Cannot access a chrome:\/\/ URL|The tab was closed|The window was closed)/i;

export function asBrowserRuntimeRace(error: unknown): BrowserRuntimeRaceError | undefined {
  if (error instanceof BrowserRuntimeRaceError) return error;
  if (error instanceof Error && EXPECTED_CHROME_RACE.test(error.message))
    return new BrowserRuntimeRaceError(undefined, { cause: error });
  return undefined;
}
