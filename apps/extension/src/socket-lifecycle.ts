// SPDX-License-Identifier: AGPL-3.0-or-later

export const SOCKET_CONNECT_TIMEOUT_MS = 20_000;
export const SOCKET_IDLE_TIMEOUT_MS = 75_000;

export function socketNeedsReconnect(
  readyState: number | undefined,
  startedAt: number,
  lastMessageAt: number,
  now = Date.now(),
) {
  if (readyState === WebSocket.OPEN) return now - lastMessageAt > SOCKET_IDLE_TIMEOUT_MS;
  if (readyState === WebSocket.CONNECTING)
    return startedAt <= 0 || now - startedAt > SOCKET_CONNECT_TIMEOUT_MS;
  return true;
}
