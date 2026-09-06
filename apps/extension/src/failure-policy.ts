// SPDX-License-Identifier: AGPL-3.0-or-later
import { ApiError, ChallengeValidationError } from "./api";
import { asBrowserRuntimeRace } from "./browser-runtime";

export type FailureDisposition = "transient" | "action-required" | "fatal";
export interface FailurePolicy {
  category: string;
  disposition: FailureDisposition;
  browserRace: boolean;
}

export function failurePolicy(error: unknown): FailurePolicy {
  if (asBrowserRuntimeRace(error))
    return { category: "BROWSER_RUNTIME_RACE", disposition: "transient", browserRace: true };
  if (
    error instanceof ApiError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  )
    return { category: "NETWORK", disposition: "transient", browserRace: false };
  if (error instanceof ApiError && [404, 409, 410].includes(error.status))
    return {
      category: "SERVER_ACTION_REQUIRED",
      disposition: "action-required",
      browserRace: false,
    };
  if (error instanceof ChallengeValidationError)
    return {
      category: `CHALLENGE_${error.code}`,
      disposition: "fatal",
      browserRace: false,
    };
  const message = error instanceof Error ? error.message : "";
  return {
    category: /decrypt|cipher|signature|workspace revision|membership|control|fork/i.test(message)
      ? "INTEGRITY_OR_CRYPTO"
      : "UNEXPECTED_FATAL",
    disposition: "fatal",
    browserRace: false,
  };
}
