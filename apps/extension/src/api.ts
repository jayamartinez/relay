// SPDX-License-Identifier: AGPL-3.0-or-later
import { hash, sign } from "@relay/crypto";
import type { Challenge } from "@relay/protocol";
import { assert, canonical, LIMITS, record } from "@relay/shared";
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
        typeof error === "string" ? error : "Server request failed.",
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
    assert(
      challenge.version === 1 &&
        challenge.account === this.account &&
        challenge.device === device &&
        challenge.purpose === action &&
        challenge.digest === digest &&
        challenge.expires > Date.now() &&
        challenge.expires <= Date.now() + 60_000,
      "Invalid server challenge.",
    );
    return this.post(action, payload, { challenge, signature: await sign(key, challenge) });
  }
}
