import { describe, expect, it } from "vitest";
import { ApiError, ChallengeValidationError } from "./api";
import { BrowserRuntimeRaceError } from "./browser-runtime";
import { failurePolicy } from "./failure-policy";

describe("controller failure policy", () => {
  it("retries only expected browser and transport failures", () => {
    expect(failurePolicy(new BrowserRuntimeRaceError())).toMatchObject({
      category: "BROWSER_RUNTIME_RACE",
      disposition: "transient",
    });
    expect(failurePolicy(new Error("No tab with id: 12."))).toMatchObject({
      category: "BROWSER_RUNTIME_RACE",
      disposition: "transient",
    });
    expect(failurePolicy(new ApiError(0, "offline"))).toMatchObject({
      category: "NETWORK",
      disposition: "transient",
    });
    expect(failurePolicy(new ChallengeValidationError("EXPIRED"))).toMatchObject({
      category: "CHALLENGE_EXPIRED",
      disposition: "transient",
    });
  });

  it("does not weaken protocol, cryptographic, or unknown failures", () => {
    expect(failurePolicy(new ChallengeValidationError("DIGEST_MISMATCH"))).toMatchObject({
      category: "CHALLENGE_DIGEST_MISMATCH",
      disposition: "fatal",
    });
    expect(failurePolicy(new Error("Workspace decryption failed."))).toMatchObject({
      category: "INTEGRITY_OR_CRYPTO",
      disposition: "fatal",
    });
    expect(failurePolicy(new Error("unexpected"))).toMatchObject({
      category: "UNEXPECTED_FATAL",
      disposition: "fatal",
    });
  });
});
