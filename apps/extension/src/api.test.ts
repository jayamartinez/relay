// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { ChallengeValidationError, validateChallenge } from "./api";

const now = 1_000_000;
const expected = {
  account: "account",
  device: "device",
  purpose: "recover-join",
  digest: "digest",
};
const challenge = {
  version: 1 as const,
  ...expected,
  nonce: "nonce",
  issued: now,
  expires: now + 30_000,
};

it("accepts a bounded server/client clock difference for challenges", () => {
  expect(validateChallenge(challenge, expected, now + 90_000)).toEqual(challenge);
});
it("accepts an older v1 challenge that omitted issued-at", () => {
  const legacy = { ...challenge } as Record<string, unknown>;
  delete legacy.issued;
  expect(validateChallenge(legacy, expected, now)).toMatchObject({
    ...challenge,
    issued: now,
  });
});
it.each([
  ["ACCOUNT_HANDLE_MISMATCH", { account: "other" }],
  ["PURPOSE_MISMATCH", { purpose: "push" }],
  ["EXPIRED", { issued: now - 200_000, expires: now - 170_000 }],
  ["ISSUED_IN_FUTURE", { issued: now + 200_000, expires: now + 230_000 }],
])("reports challenge validation failures: %s", (code, patch) => {
  try {
    validateChallenge({ ...challenge, ...patch }, expected, now);
    throw new Error("Expected challenge validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ChallengeValidationError);
    expect((error as ChallengeValidationError).code).toBe(code);
  }
});
