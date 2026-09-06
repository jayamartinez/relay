// SPDX-License-Identifier: AGPL-3.0-or-later
import { hash, sign } from "@relay/crypto";
import { CHALLENGE_LIFETIME_MS, type Challenge, CLOCK_SKEW_MS } from "@relay/protocol";
import {
  assert,
  canonical,
  id,
  integer,
  record,
  SYNC_CLIENT_RESPONSE_BYTE_LIMIT,
  serverOrigin,
  text,
} from "@relay/shared";

declare const __DEV__: boolean;

// Browser errors can include URLs or user data. Only known runtime messages are
// safe to copy into diagnostics; the original exception stays on Error.cause.
function errorDetails(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : "Error";
  const message = error instanceof Error ? error.message : "";
  const safe =
    /^(Failed to fetch|signal timed out|The operation timed out\.?|The operation was aborted\.?|The user aborted a request\.?|AbortSignal\.timeout is not a function)$/.test(
      message,
    );
  return `${name}: ${safe ? message : "details withheld (may contain private data)"}`;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "SERVER_REQUEST_FAILED",
    readonly stage = "SERVER_VALIDATION",
    cause?: unknown,
  ) {
    super(message, { cause });
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
      expires: integer(value.expires),
      // Older v1 Workers did not include issued-at. Keep the received shape
      // untouched for its signature, but derive the known 30-second lifetime
      // locally so a rebuilt extension can still authenticate with one.
      issued:
        value.issued === undefined
          ? integer(value.expires) - CHALLENGE_LIFETIME_MS
          : integer(value.issued),
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
    readonly onTrace?: (event: string) => void,
    readonly onRequest?: () => void,
  ) {}
  private trace(action: string, event: string) {
    if (!__DEV__) return;
    const enrollment = [
      "create",
      "health",
      "pair-start",
      "pair-read",
      "pair-reveal",
      "recover-info",
      "recover-join",
    ].includes(action);
    if (!enrollment && !/failed|rejected|VALIDATION/.test(event)) return;
    const message = `[Relay:api] ${action} ${event}`;
    this.onTrace?.(message);
    console.debug(message);
  }
  private prepare<T>(action: string, stage: string, operation: () => T): T {
    try {
      const value = operation();
      this.trace(action, `${stage} successful`);
      return value;
    } catch (cause) {
      this.trace(action, `${stage} failed — ${errorDetails(cause)}`);
      throw new Error(`Relay request preparation failed (${stage}_FAILED).`, { cause });
    }
  }
  private endpoint(action: string): string {
    return this.prepare(action, "ENDPOINT", () => {
      const origin = serverOrigin(this.origin, __DEV__);
      assert(/^[a-z-]+$/.test(action), "Invalid Relay action.");
      if (action === "health") return `${origin}/health`;
      assert(/^[a-f0-9]{64}$/.test(this.account), "Invalid Relay account handle.");
      return `${origin}/v1/${this.account}/${action}`;
    });
  }
  private async request(action: string, url: string, body?: string): Promise<Response> {
    const init = this.prepare<RequestInit>(action, "REQUEST_SETUP", () => ({
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    }));
    this.trace(action, "FETCH invoking fetch");
    let response: Response;
    this.onRequest?.();
    try {
      response = await fetch(url, init);
    } catch (cause) {
      this.trace(action, `FETCH rejected — ${errorDetails(cause)}`);
      const timeout = cause instanceof Error && cause.name === "TimeoutError";
      throw new ApiError(
        0,
        timeout
          ? "Relay server did not respond within 12 seconds. Your local changes are saved."
          : "Relay server is unreachable. Your local changes are saved.",
        timeout ? "NETWORK_TIMEOUT" : "NETWORK_FETCH_FAILED",
        "FETCH",
        cause,
      );
    }
    this.trace(action, `FETCH returned HTTP ${response.status}`);
    return response;
  }
  async post<T>(action: string, payload: unknown, proof?: unknown): Promise<T> {
    const url = this.endpoint(action);
    const body = this.prepare(action, "SERIALIZATION", () => JSON.stringify({ payload, proof }));
    if (__DEV__)
      this.trace(action, `body size: ${new TextEncoder().encode(body).byteLength} bytes`);
    const response = await this.request(action, url, body);
    return (await this.readResponse(action, response)) as T;
  }
  private async readResponse(action: string, response: Response): Promise<unknown> {
    let parsed: unknown;
    try {
      parsed = await this.parseResponse(response);
    } catch (cause) {
      this.trace(action, `RESPONSE_PARSE failed — ${errorDetails(cause)}`);
      if (cause instanceof ApiError) throw cause;
      // Proxies can return HTML for a temporary outage or rate limit. Preserve the
      // HTTP failure category even when that response is not Relay JSON.
      if (response.status === 408 || response.status === 429 || response.status >= 500)
        throw new ApiError(
          response.status,
          "Relay server temporarily unavailable.",
          "NETWORK_RESPONSE_FAILED",
          "RESPONSE",
          cause,
        );
      throw new Error("Relay could not read the server response (RESPONSE_PARSE_FAILED).", {
        cause,
      });
    }
    if (!response.ok) {
      const error = record(parsed).error;
      const structured = error && typeof error === "object" ? record(error) : undefined;
      const code =
        typeof structured?.code === "string" && /^[A-Z_]{1,80}$/.test(structured.code)
          ? structured.code
          : "SERVER_REQUEST_FAILED";
      this.trace(action, `SERVER_VALIDATION code=${code}`);
      throw new ApiError(
        response.status,
        typeof error === "string"
          ? error
          : typeof structured?.message === "string"
            ? structured.message
            : "Server request failed.",
        code,
      );
    }
    this.trace(action, "RESPONSE_PARSE successful");
    return parsed;
  }
  private async parseResponse(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let content = "";
    let size = 0;
    if (reader)
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (cause) {
          throw new ApiError(
            0,
            "Relay connection interrupted while reading the response. Your local changes are saved.",
            "NETWORK_RESPONSE_INTERRUPTED",
            "RESPONSE",
            cause,
          );
        }
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > SYNC_CLIENT_RESPONSE_BYTE_LIMIT) {
          await reader.cancel();
          throw new Error("Server response is too large.");
        }
        content += decoder.decode(chunk.value, { stream: true });
      }
    content += decoder.decode();
    return JSON.parse(content);
  }
  async health() {
    const response = await this.request("health", this.endpoint("health"));
    const value = record(await this.readResponse("health", response));
    assert(
      value.name === "Relay" && value.protocolVersion === 1,
      "The server is not a compatible Relay server (HEALTH_PROTOCOL_MISMATCH).",
    );
    this.trace("health", "Relay protocol v1 verified");
    return { status: response.status, name: "Relay", protocolVersion: 1 };
  }
  async authenticated<T>(
    action: string,
    payload: unknown,
    device: string,
    key: CryptoKey,
  ): Promise<T> {
    let digest: string;
    try {
      digest = await hash(canonical(payload));
    } catch (cause) {
      this.trace(action, `PROOF_DIGEST failed — ${errorDetails(cause)}`);
      throw new Error("Relay could not construct request proof (PROOF_DIGEST_FAILED).", { cause });
    }
    const requestedAt = Date.now();
    const challenge = await this.post<Challenge>("challenge", { device, purpose: action, digest });
    this.trace(action, "CHALLENGE response received");
    try {
      validateChallenge(challenge, { account: this.account, device, purpose: action, digest });
    } catch (error) {
      this.trace(
        action,
        `CHALLENGE_VALIDATION code=${error instanceof ChallengeValidationError ? error.code : "SCHEMA_INVALID"}`,
      );
      throw error;
    }
    let signature: string;
    try {
      signature = await sign(key, challenge);
    } catch (cause) {
      this.trace(action, `PROOF_SIGNATURE failed — ${errorDetails(cause)}`);
      throw new Error("Relay could not sign request proof (PROOF_SIGNATURE_FAILED).", { cause });
    }
    // A sleeping laptop can resume after the server has discarded this one-use
    // challenge. Refresh authentication rather than treating expiry as corruption.
    if (Date.now() - requestedAt >= CHALLENGE_LIFETIME_MS)
      throw new ChallengeValidationError("EXPIRED");
    try {
      return await this.post(action, payload, { challenge, signature });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 400 &&
        error.code === "REQUEST_VALIDATION_FAILED" &&
        Date.now() - requestedAt >= CHALLENGE_LIFETIME_MS
      )
        throw new ChallengeValidationError("EXPIRED");
      throw error;
    }
  }
}
