// SPDX-License-Identifier: AGPL-3.0-or-later
import { Controller } from "./controller";
import { groupsAvailable } from "./group-browser";

const controller = new Controller();
let serial: Promise<unknown> = Promise.resolve();
function run<T>(task: () => Promise<T>): Promise<T> {
  const next = serial.then(async () => {
    await controller.load();
    return task();
  });
  serial = next.catch((error) => controller.failure(error));
  return next;
}
controller.wake = () => {
  void run(() => controller.reconnect()).catch(() => {});
};
controller.onSocketMessage = (data) => {
  void run(() => controller.socketMessage(data)).catch(() => {});
};
let debounce: ReturnType<typeof setTimeout> | undefined;
function changed() {
  controller.events.changed();
  schedule();
}
function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(
    () => {
      void run(() => controller.browserChanged())
        .catch(() => {})
        .finally(() => {
          if (controller.events.readyAt > 0) schedule();
        });
    },
    Math.max(0, controller.events.readyAt - Date.now()),
  );
}
chrome.tabs.onCreated.addListener(changed);
chrome.tabs.onRemoved.addListener((id, info) => {
  controller.tabRemoved(id, info.windowId, info.isWindowClosing);
  schedule();
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url !== undefined || change.status === "complete") {
    const url = change.url ?? tab.pendingUrl ?? tab.url;
    if (url) {
      controller.navigationEvent(id, url, change.status === "complete");
      schedule();
    }
  }
  if (change.pinned !== undefined || change.groupId !== undefined) changed();
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) {
    controller.navigationCommitted(
      details.tabId,
      details.url,
      details.transitionType,
      details.transitionQualifiers,
    );
    schedule();
  }
});
if (groupsAvailable()) {
  chrome.tabGroups.onCreated.addListener(changed);
  chrome.tabGroups.onRemoved.addListener(changed);
  chrome.tabGroups.onMoved.addListener(changed);
  // A collapsed-only event updates local observation, but produces no wire mutation.
  chrome.tabGroups.onUpdated.addListener(changed);
}
chrome.tabs.onMoved.addListener(changed);
chrome.tabs.onAttached.addListener(changed);
chrome.tabs.onDetached.addListener(changed);
chrome.windows.onCreated.addListener((window) => {
  if (window.id !== undefined && window.type === "normal" && !window.incognito)
    controller.events.windowCreated(window.id);
  schedule();
});
chrome.windows.onRemoved.addListener((id) => {
  controller.windowRemoved(id);
  schedule();
});
chrome.runtime.onStartup.addListener(() => {
  void run(() => controller.reconnect()).catch(() => {});
});
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "relay-reconnect") void run(() => controller.watchdog()).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL("")) ||
    sender.tab?.incognito
  )
    return false;
  void run(async () => {
    switch (message.action) {
      case "status":
        if (message.poll) await controller.pollPair();
        return controller.status();
      case "create":
        return controller.create(message.server, message.name);
      case "start":
        return controller.start();
      case "join":
        return controller.join(message.server, message.account, message.name);
      case "review":
        return controller.review(message.id);
      case "approve":
        return controller.approve(message.id, message.code);
      case "deny":
        return controller.deny(message.id);
      case "finish-pair":
        return controller.finishPair(message.code);
      case "recover":
        return controller.recover(message.server, message.account, message.name, message.code);
      case "merge":
        return controller.merge();
      case "rename":
        return controller.rename(message.id, message.name);
      case "revoke":
        return controller.revoke(message.id);
      case "pause":
        return controller.pause(message.value);
      case "retry":
        return controller.retry();
      case "preferences":
        return controller.updatePreferences(message.preferences ?? {});
      case "cancel":
        return controller.cancelSetup();
      default:
        throw new Error("Unknown Relay action.");
    }
  }).then(
    (value) => sendResponse({ ok: true, value }),
    (error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Relay could not complete this action.",
      }),
  );
  return true;
});
void run(() => Promise.resolve()).catch(() => {});
