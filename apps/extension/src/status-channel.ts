// SPDX-License-Identifier: AGPL-3.0-or-later
export function watchStatus(changed: () => void): void {
  let retry = 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let port: chrome.runtime.Port | undefined;
  const connect = () => {
    if (stopped) return;
    port = chrome.runtime.connect({ name: "relay-status" });
    port.onMessage.addListener((message) => {
      if (message?.type !== "status-changed") return;
      retry = 1000;
      changed();
    });
    port.onDisconnect.addListener(() => {
      if (stopped) return;
      // Reattach after MV3 restart without polling status or reloading the UI.
      timer = setTimeout(connect, retry);
      retry = Math.min(30_000, retry * 2);
    });
  };
  window.addEventListener(
    "pagehide",
    () => {
      stopped = true;
      clearTimeout(timer);
      port?.disconnect();
    },
    { once: true },
  );
  connect();
}
