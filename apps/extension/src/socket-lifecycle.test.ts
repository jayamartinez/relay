import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOCKET_CONNECT_TIMEOUT_MS,
  SOCKET_IDLE_TIMEOUT_MS,
  socketNeedsReconnect,
} from "./socket-lifecycle";

describe("socket watchdog policy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps fresh open and connecting sockets", () => {
    vi.stubGlobal("WebSocket", { CONNECTING: 0, OPEN: 1 });
    expect(socketNeedsReconnect(WebSocket.OPEN, 0, 1_000, 1_000 + SOCKET_IDLE_TIMEOUT_MS)).toBe(
      false,
    );
    expect(
      socketNeedsReconnect(WebSocket.CONNECTING, 1_000, 0, 1_000 + SOCKET_CONNECT_TIMEOUT_MS),
    ).toBe(false);
  });

  it("reconnects stale, closed, and missing sockets", () => {
    vi.stubGlobal("WebSocket", { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
    expect(socketNeedsReconnect(WebSocket.OPEN, 0, 1_000, 1_001 + SOCKET_IDLE_TIMEOUT_MS)).toBe(
      true,
    );
    expect(
      socketNeedsReconnect(WebSocket.CONNECTING, 1_000, 0, 1_001 + SOCKET_CONNECT_TIMEOUT_MS),
    ).toBe(true);
    expect(socketNeedsReconnect(WebSocket.CLOSED, 0, 0, 1_000)).toBe(true);
    expect(socketNeedsReconnect(undefined, 0, 0, 1_000)).toBe(true);
  });
});
