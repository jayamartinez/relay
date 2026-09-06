// SPDX-License-Identifier: AGPL-3.0-or-later
import { APPROVAL_EXPIRY_ALARM, Controller } from "./controller";
import { groupsAvailable } from "./group-browser";
import { SerialTaskQueue } from "./serial-task-queue";

const controller = new Controller();
const statusPorts = new Set<chrome.runtime.Port>();
function broadcastStatusChanged() {
  for (const port of statusPorts)
    try {
      port.postMessage({ type: "status-changed" });
    } catch {
      statusPorts.delete(port);
    }
}
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "relay-status" || port.sender?.id !== chrome.runtime.id) return;
  statusPorts.add(port);
  port.onDisconnect.addListener(() => statusPorts.delete(port));
});
const serial = new SerialTaskQueue();
controller.pendingTasks = () => serial.pending;
function run<T>(task: () => Promise<T>): Promise<T> {
  return serial.run(
    async () => {
      await controller.load();
      return task();
    },
    (error) => controller.failure(error),
  );
}
controller.wake = () => {
  void run(() => controller.reconnect())
    .then(broadcastStatusChanged)
    .catch(() => {});
};
controller.onSocketMessage = (data) => {
  void run(() => controller.socketMessage(data))
    .then(broadcastStatusChanged)
    .catch(() => {});
};
let debounce: ReturnType<typeof setTimeout> | undefined;
let browserTaskQueued = false;
function changed() {
  controller.events.changed();
  schedule();
}
function schedule() {
  if (browserTaskQueued) return;
  clearTimeout(debounce);
  debounce = setTimeout(
    () => {
      browserTaskQueued = true;
      void run(() => controller.browserChanged())
        .catch(() => {})
        .finally(() => {
          browserTaskQueued = false;
          if (controller.browserWorkPending) schedule();
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
  chrome.tabGroups.onUpdated.addListener((group) => {
    // Collapsed state is a per-device preference, persisted by logical Relay group ID.
    void run(() => controller.groupUpdated(group.id, group.collapsed)).catch(() => {});
    changed(); // Title and color still flow through normal canonical observation.
  });
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
  if (alarm.name === APPROVAL_EXPIRY_ALARM)
    void run(() => controller.expireApprovals())
      .then(broadcastStatusChanged)
      .catch(() => {});
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
      case "refresh-approvals":
        return controller.refreshApprovals();
      case "create":
        return controller.create(message.server, message.name);
      case "start":
        return controller.start();
      case "health":
        return controller.health(message.server);
      case "join":
        return controller.join(message.server, message.account, message.name);
      case "review":
        return controller.review(message.id);
      case "approve":
        return controller.approve(message.id, message.code);
      case "deny":
        return controller.deny(message.id);
      case "dismiss-approval-result":
        return controller.dismissApprovalResult();
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
    (value) => {
      if (message.action !== "status") broadcastStatusChanged();
      sendResponse({ ok: true, value });
    },
    (error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Relay could not complete this action.",
      }),
  );
  return true;
});
void run(() => Promise.resolve()).catch(() => {});
