// SPDX-License-Identifier: AGPL-3.0-or-later
import { identity } from "@relay/crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Api, ApiError, ChallengeValidationError, validateChallenge } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["sign", "response"])(
  "refreshes an expired challenge after laptop sleep during %s without accepting invalid authentication",
  async (stage) => {
    vi.stubGlobal("__DEV__", false);
    const device = await identity();
    let now = 100_000,
      sleep = true;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const result = await sign(...args);
      if (sleep && stage === "sign") {
        now += 31_000;
        sleep = false;
      }
      return result;
    });
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/challenge")) {
        const { payload } = JSON.parse(String(init.body));
        return Response.json({
          version: 1,
          account: "a".repeat(64),
          device: payload.device,
          purpose: payload.purpose,
          digest: payload.digest,
          nonce: crypto.randomUUID(),
          issued: now,
          expires: now + 30_000,
        });
      }
      if (sleep && stage === "response") {
        now += 31_000;
        sleep = false;
        return Response.json({ error: { code: "REQUEST_VALIDATION_FAILED" } }, { status: 400 });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);
    const api = new Api("https://relay.example", "a".repeat(64));
    await expect(
      api.authenticated("sync", {}, device.device.id, device.signing),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    await expect(api.authenticated("sync", {}, device.device.id, device.signing)).resolves.toEqual({
      ok: true,
    });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("/challenge"))).toHaveLength(2);
  },
);

it.each([408, 429, 502, 503])("recovers from a non-JSON HTTP %i outage", async (status) => {
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>unavailable</html>", { status }))
      .mockResolvedValueOnce(Response.json({ ok: true })),
  );
  const api = new Api("https://relay.example", "a".repeat(64));
  await expect(api.post("sync", {})).rejects.toMatchObject({
    status,
    code: "NETWORK_RESPONSE_FAILED",
  });
  await expect(api.post("sync", {})).resolves.toEqual({ ok: true });
});

it.each(["AbortError", "TimeoutError", "TypeError"])(
  "recovers when the response stream fails with %s after headers",
  async (name) => {
    vi.stubGlobal("__DEV__", false);
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("test interruption", name));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(stream))
        .mockResolvedValueOnce(Response.json({ ok: true })),
    );
    const api = new Api("https://relay.example", "a".repeat(64));
    await expect(api.post("sync", {})).rejects.toMatchObject({
      status: 0,
      code: "NETWORK_RESPONSE_INTERRUPTED",
    });
    await expect(api.post("sync", {})).resolves.toEqual({ ok: true });
  },
);

it("still fails closed on malformed successful protocol responses", async () => {
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
  await expect(
    new Api("https://relay.example", "a".repeat(64)).post("sync", {}),
  ).rejects.not.toBeInstanceOf(ApiError);
});

it("keeps request preparation failures separate from network failures", async () => {
  vi.stubGlobal("__DEV__", true);
  vi.stubGlobal("AbortSignal", {
    timeout: () => {
      throw new TypeError("AbortSignal.timeout is not a function");
    },
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const api = new Api("http://192.168.1.176:8787", "a".repeat(64));
  await expect(api.post("create", {})).rejects.toThrow("REQUEST_SETUP_FAILED");
  expect(fetch).not.toHaveBeenCalled();
});

it("preserves the actual fetch timeout as a cause and safe development trace", async () => {
  vi.stubGlobal("__DEV__", true);
  const cause = new DOMException("signal timed out", "TimeoutError");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
  const trace: string[] = [];
  const api = new Api("http://192.168.1.176:8787", "a".repeat(64), (event) => trace.push(event));
  await expect(api.post("create", {})).rejects.toMatchObject({
    cause,
    stage: "FETCH",
    code: "NETWORK_TIMEOUT",
  });
  expect(trace.join("\n")).toContain("TimeoutError: signal timed out");
});

it("does not classify a circular payload as server unreachable or log its values", async () => {
  vi.stubGlobal("__DEV__", true);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const payload: Record<string, unknown> = { secret: "private-value" };
  payload.self = payload;
  const trace: string[] = [];
  await expect(
    new Api("http://localhost:8787", "a".repeat(64), (event) => trace.push(event)).post(
      "create",
      payload,
    ),
  ).rejects.not.toBeInstanceOf(ApiError);
  expect(fetch).not.toHaveBeenCalled();
  expect(trace.join("\n")).not.toContain("private-value");
});

it("retains structured pairing error codes without printing server-supplied messages", async () => {
  vi.stubGlobal("__DEV__", true);
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: "PAIR_REQUEST_SIGNATURE_INVALID", message: "Request rejected" } },
          { status: 400 },
        ),
      ),
  );
  await expect(
    new Api("http://localhost:8787", "a".repeat(64)).post("pair-start", {}),
  ).rejects.toMatchObject({
    status: 400,
    code: "PAIR_REQUEST_SIGNATURE_INVALID",
    stage: "SERVER_VALIDATION",
  });
});

it("health requires a Relay protocol response, not merely HTTP 200", async () => {
  vi.stubGlobal("__DEV__", true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ name: "Other server" })));
  await expect(new Api("http://localhost:8787", "").health()).rejects.toThrow(
    "HEALTH_PROTOCOL_MISMATCH",
  );
});

it("sends bootstrap create to the exact LAN origin without requesting a challenge", async () => {
  vi.stubGlobal("__DEV__", true);
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await new Api("http://192.168.1.176:8787/", "a".repeat(64)).post("create", {
    control: {},
    snapshot: {},
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe(`http://192.168.1.176:8787/v1/${"a".repeat(64)}/create`);
  expect(JSON.parse(init.body)).toEqual({ payload: { control: {}, snapshot: {} } });
});

it("never emits development traces in a production build", async () => {
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true })));
  const trace = vi.fn();
  await new Api("https://relay.example", "a".repeat(64), trace).post("create", {});
  expect(trace).not.toHaveBeenCalled();
});

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
  ["DEVICE_MISMATCH", { device: "other" }],
  ["DIGEST_MISMATCH", { digest: "other" }],
  ["PROTOCOL_VERSION_MISMATCH", { version: 2 }],
  ["TIMESTAMP_INVALID", { expires: now + 30_001 }],
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
