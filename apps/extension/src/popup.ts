// SPDX-License-Identifier: AGPL-3.0-or-later

import { adjacentApprovalId, approvalPosition, currentApproval, SingleFlight } from "./approval-ui";
import type { Status } from "./controller";
import { watchStatus } from "./status-channel";
import { statusViewKey } from "./status-view";
import {
  ago,
  alertMessage,
  brand,
  button,
  call,
  countLabel,
  el,
  groupedCode,
  icon,
  statusBadge,
  syncedLabel,
} from "./ui";

const app = document.getElementById("app");
const requests = new SingleFlight();
const MAX_DEVICES = 5;
let state: Status;
let selectedId: string | undefined;
let localError: string | undefined;
let localAction: "approve" | "deny" | undefined;
let resultTimer: ReturnType<typeof setTimeout> | undefined;
let lastViewKind = "";

/** Plays the entrance motion only when the popup switches to a different view. */
function enter(popup: HTMLElement, kind: string) {
  if (kind !== lastViewKind) popup.children[1]?.classList.add("rl-enter");
  lastViewKind = kind;
}

function header(label: string) {
  return el("header", "rl-popup-header", brand(), statusBadge(label));
}

function settingsControl() {
  const control = button(
    ["Settings", icon("external")],
    () => void chrome.runtime.openOptionsPage().catch(showError),
    "rl-btn rl-btn--ghost rl-btn--sm",
  );
  control.setAttribute("aria-label", "Settings");
  return control;
}

function footer(...children: HTMLElement[]) {
  return el("footer", "rl-popup-footer", ...children);
}

function body(...children: (HTMLElement | undefined)[]) {
  return el("section", "rl-popup-body", ...children);
}

function heading(text: string, meta?: string) {
  return el(
    "div",
    "rl-workspace",
    el("h2", "rl-title rl-title--sm", text),
    meta ? el("p", "rl-small", meta) : undefined,
  );
}

function navigate(offset: -1 | 1) {
  localError = undefined;
  const request = currentApproval(state.approvals, selectedId);
  if (!request) return;
  selectedId = adjacentApprovalId(state.approvals, request.id, offset);
  render();
  void prepareCurrentRequest();
}

function spinner() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 28 28");
  svg.setAttribute("class", "rl-spinner");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  for (const [key, value] of Object.entries({
    cx: "14",
    cy: "14",
    r: "11",
    fill: "none",
    stroke: "var(--rl-line-strong)",
    "stroke-width": "2.5",
  }))
    track.setAttribute(key, value);
  const arc = document.createElementNS("http://www.w3.org/2000/svg", "path");
  for (const [key, value] of Object.entries({
    d: "M14 3a11 11 0 0 1 11 11",
    fill: "none",
    stroke: "var(--rl-signal-text)",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
  }))
    arc.setAttribute(key, value);
  svg.append(track, arc);
  return svg;
}

function result(title: string, copy: string, graphic: Element) {
  return el(
    "section",
    "rl-result",
    graphic,
    el(
      "div",
      "rl-result-copy",
      el("h2", "rl-title rl-title--sm", title),
      el("p", "rl-small", copy),
    ),
  );
}

function resultView() {
  const activity = state.approvalActivity;
  if (!activity && !localAction) return undefined;
  if (activity?.status === "working" || localAction) {
    const approving = (localAction ?? activity?.action) === "approve";
    return result(
      approving ? "Approving device…" : "Denying request…",
      approving ? "Secure approval continues if you close this popup." : "Updating Relay…",
      spinner(),
    );
  }
  if (!activity) return undefined;
  if (activity.status === "failed") {
    const canRetry = state.approvals.some((request) => request.id === activity.requestId);
    return body(
      el(
        "h2",
        "rl-title rl-title--sm",
        activity.action === "approve" ? "Couldn’t approve the device" : "Couldn’t deny the request",
      ),
      alertMessage(activity.error ?? "Relay could not complete this action."),
      el(
        "div",
        "rl-actions rl-actions--fill",
        button("Back", () => void dismissResult(), "rl-btn"),
        canRetry
          ? button(
              activity.action === "approve" ? "Review again" : "Retry",
              () =>
                void (activity.action === "approve"
                  ? dismissResult()
                  : runApproval(activity.action, activity.requestId)),
              "rl-btn rl-btn--primary",
            )
          : undefined,
      ),
    );
  }
  const approved = activity.status === "approved";
  const mark = el("div", "rl-result-icon", icon(approved ? "check" : "cross"));
  if (!approved) mark.dataset.tone = "neutral";
  return result(
    activity.connected
      ? "Device connected"
      : approved
        ? "Finishing secure pairing…"
        : "Access was not granted",
    activity.connected
      ? "It now has the workspace key and will start syncing."
      : approved
        ? "Relay is completing authorization in the background."
        : "The pending request has been removed.",
    mark,
  );
}

function pendingView() {
  const request = currentApproval(state.approvals, selectedId);
  if (!request) return undefined;
  selectedId = request.id;
  const position = approvalPosition(state.approvals, request.id);
  const section = body(
    heading(
      position.total > 1 ? `Request ${position.index + 1} of ${position.total}` : "New device",
      `Wants to join your workspace · requested ${ago(request.requestedAt).toLowerCase()}`,
    ),
  );
  section.setAttribute("aria-live", "polite");
  if (state.paused) {
    section.append(
      el("p", "rl-text", "Relay is paused. Resume to review this device request."),
      button(
        ["Resume Relay"],
        () => {
          localError = undefined;
          void requests
            .run("pause", () => call("pause", { value: false }))
            .then(update)
            .then(prepareCurrentRequest)
            .catch(showError);
        },
        "rl-btn rl-btn--primary rl-btn--block",
      ),
    );
    return section;
  }
  if (request.sas) {
    const deny = button(
      "Deny",
      () => void runApproval("deny", request.id),
      "rl-btn rl-btn--danger",
    );
    const approve = button(
      "Approve",
      () => void runApproval("approve", request.id),
      "rl-btn rl-btn--primary",
    );
    deny.disabled = !!localAction;
    approve.disabled = !!localAction;
    section.append(
      el(
        "div",
        "rl-code-well",
        el("span", "rl-caption", "Verification code"),
        el("span", "rl-code", groupedCode(request.sas)),
      ),
      el("p", "rl-text", "Approve only if this matches the code shown on the new device."),
      el("div", "rl-actions rl-actions--fill", deny, approve),
    );
  } else {
    section.append(
      el(
        "p",
        "rl-text",
        request.reviewing
          ? request.ours
            ? "Preparing the verification code… Keep both devices open."
            : "This request is being reviewed on another authorized device."
          : "Preparing secure verification…",
      ),
      el(
        "div",
        "rl-actions",
        button("Deny", () => void runApproval("deny", request.id), "rl-btn rl-btn--danger"),
      ),
    );
  }
  if (position.total > 1)
    section.append(
      el(
        "nav",
        "rl-request-nav",
        button([icon("back"), "Previous"], () => navigate(-1), "rl-btn rl-btn--ghost rl-btn--sm"),
        button(["Next", icon("next")], () => navigate(1), "rl-btn rl-btn--ghost rl-btn--sm"),
      ),
    );
  return section;
}

function setupView() {
  const welcome = state.phase === "welcome";
  const copy =
    state.phase === "pending"
      ? "Approve it from one of your other devices, then compare the code on the setup page."
      : state.phase === "merge"
        ? "Your Relay workspace is ready to merge with the tabs open here."
        : state.phase === "draft"
          ? "Save your recovery key, then start syncing."
          : "Tabs, windows, and groups, end‑to‑end encrypted. No email. No password.";
  return body(
    el(
      "div",
      "rl-workspace",
      el(
        "h2",
        "rl-title rl-title--sm",
        welcome ? "Sync this browser with your others" : "Finish setting up this device",
      ),
      el("p", "rl-small", copy),
    ),
    button(
      welcome ? "Set up Relay" : "Continue setup",
      () => void chrome.runtime.openOptionsPage(),
      "rl-btn rl-btn--primary rl-btn--block",
    ),
  );
}

function deviceMeta(device: Status["devices"][number], live: boolean) {
  if (device.id === state.device) return "This device";
  // Presence is only current while connected; otherwise show when it was last seen.
  if (device.online && live) return "Online";
  return device.lastSeen ? ago(device.lastSeen).replace(/^Just now$/, "just now") : "Offline";
}

function workspaceView() {
  const live = state.status === "Live" && !state.paused;
  const queued = state.queue;
  const workspace = el(
    "div",
    "rl-workspace",
    el("span", "rl-caption", "Main workspace"),
    el(
      "p",
      "rl-count",
      `${countLabel(state.workspace?.windows ?? 0, "window")} · ${countLabel(state.workspace?.tabs ?? 0, "tab")}`,
    ),
    el(
      "p",
      "rl-meta",
      live && queued
        ? `Syncing ${countLabel(queued, "change")}…`
        : syncedLabel(state.lastSynced, live),
      el("span", "rl-meta-sep", "·"),
      icon("lock"),
      "End-to-end encrypted",
    ),
  );
  const section = body(workspace);
  if (queued && !live)
    section.append(
      el(
        "div",
        "rl-notice",
        icon("download"),
        el(
          "span",
          "",
          state.paused
            ? `${countLabel(queued, "change")} waiting. ${queued === 1 ? "It’ll" : "They’ll"} sync when you resume.`
            : `${countLabel(queued, "change")} saved on this device. ${queued === 1 ? "It’ll" : "They’ll"} sync when Relay reconnects.`,
        ),
      ),
    );
  if (state.devices.length) {
    const online = state.devices.filter((device) => device.online).length;
    const list = el(
      "div",
      "rl-devices",
      el(
        "div",
        "rl-devices-head",
        el("span", "", "Devices"),
        el("span", "", live ? `${online} of ${state.devices.length} online` : "Last known"),
      ),
    );
    const ordered = [...state.devices].sort(
      (a, b) =>
        Number(b.id === state.device) - Number(a.id === state.device) ||
        Number(!!b.online) - Number(!!a.online),
    );
    for (const device of ordered.slice(0, MAX_DEVICES)) {
      const isThis = device.id === state.device;
      const onlineNow = isThis || (live && !!device.online);
      const dot = el("span", "rl-dot");
      dot.dataset.state = onlineNow ? "online" : "offline";
      const row = el(
        "div",
        "rl-device",
        el("span", "rl-dot-slot", dot),
        el("span", "rl-device-name", device.name),
        el("span", "rl-device-meta", deviceMeta(device, live)),
      );
      row.dataset.state = onlineNow ? "online" : "offline";
      list.append(row);
    }
    if (ordered.length > MAX_DEVICES)
      list.append(
        el(
          "div",
          "rl-devices-head",
          el("span", "", `${ordered.length - MAX_DEVICES} more in Settings`),
        ),
      );
    section.append(list);
  }
  return section;
}

function pauseControl() {
  const control = state.paused
    ? button(
        [icon("play"), "Resume Relay"],
        () => void call("pause", { value: false }).then(update).catch(showError),
        "rl-btn rl-btn--primary rl-btn--sm",
      )
    : button(
        [icon("pause"), "Pause"],
        () => void call("pause", { value: true }).then(update).catch(showError),
        "rl-btn rl-btn--ghost rl-btn--sm",
      );
  control.setAttribute("aria-label", state.paused ? "Resume Relay" : "Pause Relay");
  return control;
}

function headerLabel(attention: boolean) {
  if (attention) return "Needs attention";
  if (state.phase === "welcome") return "Not set up";
  if (state.phase === "pending") return "Waiting for approval";
  if (state.phase !== "active") return "Setup";
  if (state.status === "Live" && state.queue) return "Syncing";
  return state.status;
}

function render() {
  if (!app) return;
  clearTimeout(resultTimer);
  const popup = el("div", "rl-popup");
  if (!state) {
    popup.append(
      header("Not connected"),
      body(
        alertMessage(localError ?? "Relay background worker is unavailable."),
        el(
          "div",
          "rl-actions",
          button("Retry", () => void load(), "rl-btn rl-btn--primary rl-btn--sm"),
        ),
      ),
      footer(settingsControl()),
    );
    app.replaceChildren(popup);
    return;
  }
  const actionResult = resultView();
  const failure =
    state.approvalActivity?.status === "failed" ? undefined : localError || state.error;
  const approval = actionResult ?? pendingView();
  popup.append(header(headerLabel(!!(approval || failure))));
  if (approval) {
    if (failure) approval.prepend(alertMessage(failure));
    popup.append(approval, footer(settingsControl()));
    enter(
      popup,
      actionResult
        ? `result:${state.approvalActivity?.status ?? localAction}`
        : `request:${selectedId}`,
    );
    app.replaceChildren(popup);
    scheduleResultDismissal();
    return;
  }
  if (state.phase !== "active") {
    const view = setupView();
    if (failure) view.prepend(alertMessage(failure));
    popup.append(view, footer(settingsControl()));
  } else {
    const view = workspaceView();
    if (failure) view.prepend(alertMessage(failure));
    popup.append(view, footer(pauseControl(), settingsControl()));
  }
  enter(popup, state.phase === "active" ? "workspace" : `setup:${state.phase}`);
  app.replaceChildren(popup);
}

function update(next: Status) {
  const changed = !state || statusViewKey(state) !== statusViewKey(next);
  state = next;
  if (!changed) return;
  if (selectedId && !state.approvals.some((request) => request.id === selectedId))
    selectedId = undefined;
  render();
}

async function runApproval(action: "approve" | "deny", requestId: string) {
  const request = state.approvals.find((candidate) => candidate.id === requestId);
  if (!request || (action === "approve" && !request.sas)) return;
  const key = `${action}:${requestId}`;
  if (requests.has(key)) return;
  localError = undefined;
  localAction = action;
  render();
  try {
    const next = await requests.run(key, () =>
      call(action, { id: requestId, ...(action === "approve" ? { code: request.sas } : {}) }),
    );
    update(next);
  } catch (error) {
    try {
      update(await call("status"));
    } catch {
      // Preserve the original action error if the status read also fails.
    }
    showError(error);
  } finally {
    localAction = undefined;
    render();
  }
}

async function prepareCurrentRequest() {
  if (state.paused || state.approvalActivity || localAction) return;
  const request = currentApproval(state.approvals, selectedId);
  if (!request || request.reviewing) return;
  const key = `review:${request.id}`;
  try {
    update(await requests.run(key, () => call("review", { id: request.id })));
  } catch (error) {
    showError(error);
  }
}

async function dismissResult() {
  localError = undefined;
  selectedId = state.approvalActivity?.requestId;
  try {
    update(await requests.run("dismiss-result", () => call("dismiss-approval-result")));
    await prepareCurrentRequest();
  } catch (error) {
    showError(error);
  }
}

function scheduleResultDismissal() {
  clearTimeout(resultTimer);
  const activity = state.approvalActivity;
  if (!activity?.finishedAt || activity.status === "failed" || localError) return;
  const remaining = Math.max(0, activity.finishedAt + 2_500 - Date.now());
  resultTimer = setTimeout(() => {
    void call("dismiss-approval-result").then(update).then(prepareCurrentRequest).catch(showError);
  }, remaining);
}

function showError(error: unknown) {
  localError = error instanceof Error ? error.message : "Relay is unavailable.";
  render();
}

async function reconcile() {
  if (state.paused) return;
  try {
    update(await call("refresh-approvals"));
    await prepareCurrentRequest();
  } catch (error) {
    showError(error);
  }
}

async function load() {
  localError = undefined;
  try {
    update(await requests.run("status", () => call("status")));
    await reconcile();
  } catch (error) {
    showError(error);
  }
}

watchStatus(() => {
  if (!document.hidden)
    void call("status").then(update).then(prepareCurrentRequest).catch(showError);
});
void load();
