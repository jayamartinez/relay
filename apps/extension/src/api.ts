// SPDX-License-Identifier: AGPL-3.0-or-later
import { hash, sign } from "@relay/crypto";
import { CHALLENGE_LIFETIME_MS, type Challenge, CLOCK_SKEW_MS } from "@relay/protocol";
import { assert, canonical, id, integer, LIMITS, record, text } from "@relay/shared";
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type ChallengeValidationFailure =
  | "SCHEMA_INVALID"
  | "PROTOCOL_VERSION_MISMATCH"
  | "ACCOUNT_HANDLE_MISMATCH"
  | "DEVICE_MISMATCH"
  | "PURPOSE_MISMATCH"
  | "DIGEST_MISMATCH"
  | "NONCE_INVALID"
  | "TIMESTAMP_INVALID"
  | "EXPIRED"
  | "ISSUED_IN_FUTURE";
export class ChallengeValidationError extends Error {
  constructor(readonly code: ChallengeValidationFailure) {
    super(`Invalid server challenge (${code}).`);
  }
}
export function validateChallenge(
  raw: unknown,
  expected: Pick<Challenge, "account" | "device" | "purpose" | "digest">,
  now = Date.now(),
): Challenge {
  let challenge: Challenge;
  try {
    const value = record(raw);
    challenge = {
      version: value.version as 1,
      account: text(value.account, 64),
      device: id(value.device),
      purpose: text(value.purpose, 40),
      nonce: id(value.nonce),
      issued: integer(value.issued),
      expires: integer(value.expires),
      digest: text(value.digest, 64),
    };
  } catch {
    throw new ChallengeValidationError("SCHEMA_INVALID");
  }
  if (challenge.version !== 1) throw new ChallengeValidationError("PROTOCOL_VERSION_MISMATCH");
  if (challenge.account !== expected.account)
    throw new ChallengeValidationError("ACCOUNT_HANDLE_MISMATCH");
  if (challenge.device !== expected.device) throw new ChallengeValidationError("DEVICE_MISMATCH");
  if (challenge.purpose !== expected.purpose)
    throw new ChallengeValidationError("PURPOSE_MISMATCH");
  if (challenge.digest !== expected.digest) throw new ChallengeValidationError("DIGEST_MISMATCH");
  if (!challenge.nonce) throw new ChallengeValidationError("NONCE_INVALID");
  if (
    challenge.expires <= challenge.issued ||
    challenge.expires - challenge.issued > CHALLENGE_LIFETIME_MS
  )
    throw new ChallengeValidationError("TIMESTAMP_INVALID");
  if (challenge.issued > now + CLOCK_SKEW_MS)
    throw new ChallengeValidationError("ISSUED_IN_FUTURE");
  if (challenge.expires <= now - CLOCK_SKEW_MS) throw new ChallengeValidationError("EXPIRED");
  return challenge;
}
export class Api {
  constructor(
    readonly origin: string,
    readonly account: string,
  ) {}
  async post<T>(action: string, payload: unknown, proof?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.origin}/v1/${this.account}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload, proof }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new ApiError(0, "Relay server is unreachable. Your local changes are saved.");
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let size = 0;
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > LIMITS.message * 4) {
          await reader.cancel();
          throw new Error("Server response is too large.");
        }
        content += decoder.decode(chunk.value, { stream: true });
      }
    content += decoder.decode();
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error("The server returned unexpected data.");
    }
    if (!response.ok) {
      const error = record(parsed).error;
      throw new ApiError(
        response.status,
        typeof error === "string"
          ? error
          : error && typeof error === "object" && typeof record(error).message === "string"
            ? (record(error).message as string)
            : "Server request failed.",
      );
    }
    return parsed as T;
  }
  async authenticated<T>(
    action: string,
    payload: unknown,
    device: string,
    key: CryptoKey,
  ): Promise<T> {
    const digest = await hash(canonical(payload));
    const challenge = await this.post<Challenge>("challenge", { device, purpose: action, digest });
    validateChallenge(challenge, { account: this.account, device, purpose: action, digest });
    return this.post(action, payload, { challenge, signature: await sign(key, challenge) });
  }
}
