// SPDX-License-Identifier: AGPL-3.0-or-later

import { adjacentApprovalId, approvalPosition, currentApproval, SingleFlight } from "./approval-ui";
import type { Status } from "./controller";
import { ago, brand, button, call, countLabel, el, groupedCode, masked, statusBadge } from "./ui";

const app = document.getElementById("app");
const requests = new SingleFlight();
let state: Status;
let selectedId: string | undefined;
let localAction: "approve" | "deny" | undefined;
let resultTimer: ReturnType<typeof setTimeout> | undefined;

function footer() {
  return el("div", "footer", "End-to-end encrypted · Relay 1.0.0");
}

function errorMessage(text: string) {
  const message = el(
    "div",
    "error popup-error",
    el("span", "error-title", "Couldn’t complete that"),
    el("p", "", text),
  );
  message.setAttribute("role", "alert");
  return message;
}

function approvalHeader(label = "Needs attention") {
  return el("header", "popup-header", brand(), statusBadge(label));
}

function navigate(offset: -1 | 1) {
  const request = currentApproval(state.approvals, selectedId);
  if (!request) return;
  selectedId = adjacentApprovalId(state.approvals, request.id, offset);
  render();
  void prepareCurrentRequest();
}

function resultView() {
  const activity = state.approvalActivity;
  if (!activity && !localAction) return undefined;
  if (activity?.status === "working" || localAction) {
    const approving = (localAction ?? activity?.action) === "approve";
    return el(
      "section",
      "popup-approval popup-progress",
      el("div", "eyebrow", "New device request"),
      el("h2", "", approving ? "Approving device…" : "Denying request…"),
      el(
        "p",
        "popup-approval-copy",
        approving ? "Secure approval continues if this popup closes." : "Updating Relay…",
      ),
    );
  }
  if (!activity) return undefined;
  if (activity.status === "failed") {
    const canRetry = state.approvals.some((request) => request.id === activity.requestId);
    return el(
      "section",
      "popup-approval popup-progress",
      el("div", "eyebrow", "New device request"),
      el(
        "h2",
        "",
        activity.action === "approve" ? "Could not approve device" : "Could not deny request",
      ),
      errorMessage(activity.error ?? "Relay could not complete this action."),
      ...(canRetry
        ? [
            el(
              "div",
              "popup-approval-actions",
              button(
                "Retry",
                () => void runApproval(activity.action, activity.requestId),
                "primary compact",
              ),
            ),
          ]
        : []),
    );
  }
  const approved = activity.status === "approved";
  return el(
    "section",
    "popup-approval popup-progress",
    el("div", "eyebrow", approved ? "Device approved" : "Request denied"),
    el(
      "h2",
      "",
      activity.connected
        ? "Device connected"
        : approved
          ? "Finishing secure pairing…"
          : "Access was not granted",
    ),
    el(
      "p",
      "popup-approval-copy",
      approved
        ? "Relay is completing authorization in the background."
        : "The pending request has been removed.",
    ),
  );
}

function pendingView() {
  const request = currentApproval(state.approvals, selectedId);
  if (!request) return undefined;
  selectedId = request.id;
  const position = approvalPosition(state.approvals, request.id);
  const section = el("section", "popup-approval");
  section.setAttribute("aria-live", "polite");
  section.append(
    el("div", "eyebrow", "New device request"),
    el(
      "h2",
      "",
      position.total > 1 ? `Request ${position.index + 1} of ${position.total}` : "New device",
    ),
    el("p", "popup-request-meta", `Requested ${ago(request.requestedAt).toLowerCase()}`),
  );
  if (request.sas) {
    section.append(
      el("div", "eyebrow popup-code-label", "Verification code"),
      el("div", "code popup-code", groupedCode(request.sas)),
      el("p", "popup-approval-copy", "Make sure this matches the code shown on the other device."),
    );
    const deny = button("Deny", () => void runApproval("deny", request.id), "danger compact");
    const approve = button(
      "Approve",
      () => void runApproval("approve", request.id),
      "primary compact",
    );
    deny.disabled = !!localAction;
    approve.disabled = !!localAction;
    section.append(el("div", "popup-approval-actions", deny, approve));
  } else {
    section.append(
      el(
        "p",
        "popup-approval-copy popup-preparing",
        request.reviewing
          ? request.ours
            ? "Preparing the verification code… Keep both devices open."
            : "This request is being reviewed on another authorized device."
          : "Preparing secure verification…",
      ),
      el(
        "div",
        "popup-approval-actions",
        button("Deny", () => void runApproval("deny", request.id), "danger compact"),
      ),
    );
  }
  if (position.total > 1)
    section.append(
      el(
        "nav",
        "popup-request-nav",
        button("← Previous", () => navigate(-1), "ghost compact"),
        button("Next →", () => navigate(1), "ghost compact"),
      ),
    );
  return section;
}

function render() {
  if (!app || !state) return;
  const actionResult = resultView();
  if (state.error && state.approvalActivity?.status !== "failed") {
    app.replaceChildren(approvalHeader(state.status), errorMessage(state.error), footer());
    return;
  }
  const approval = actionResult ?? pendingView();
  if (approval) {
    app.replaceChildren(approvalHeader(), approval, footer());
    scheduleResultDismissal();
    return;
  }
  app.replaceChildren(approvalHeader(state.status));
  if (state.phase !== "active") {
    app.append(
      el("h2", "popup-title", "Your workspace, everywhere."),
      el("p", "", "End-to-end encrypted. No email. No password."),
      button("Set up Relay", () => void chrome.runtime.openOptionsPage(), "primary"),
    );
  } else {
    app.append(
      el(
        "section",
        "popup-workspace",
        el("div", "eyebrow", "Main workspace"),
        el(
          "p",
          "metric",
          `${countLabel(state.workspace?.windows ?? 0, "window")} · ${countLabel(state.workspace?.tabs ?? 0, "tab")}`,
        ),
        el(
          "p",
          "popup-meta",
          `${countLabel(state.devices.filter((device) => device.online).length, "device")} connected · ${countLabel(state.queue, "change")} queued`,
        ),
        el("small", "", `Last synced ${ago(state.lastSynced)}`),
      ),
      el(
        "nav",
        "popup-actions",
        button(
          state.paused ? "Resume Relay" : "Pause Relay",
          () => void call("pause", { value: !state.paused }).then(update).catch(showError),
          "secondary compact",
        ),
        button("Settings →", () => void chrome.runtime.openOptionsPage(), "ghost compact"),
      ),
      el(
        "div",
        "popup-account",
        el("span", "", "Account"),
        el("small", "", state.account ? masked(state.account) : ""),
      ),
    );
  }
  app.append(footer());
}

function update(next: Status) {
  state = next;
  if (selectedId && !state.approvals.some((request) => request.id === selectedId))
    selectedId = undefined;
  render();
}

async function runApproval(action: "approve" | "deny", requestId: string) {
  const request = state.approvals.find((candidate) => candidate.id === requestId);
  if (!request || (action === "approve" && !request.sas)) return;
  const key = `${action}:${requestId}`;
  if (requests.has(key)) return;
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
      showError(error);
    }
  } finally {
    localAction = undefined;
    render();
  }
}

async function prepareCurrentRequest() {
  const request = currentApproval(state.approvals, selectedId);
  if (!request || request.reviewing) return;
  const key = `review:${request.id}`;
  try {
    update(await requests.run(key, () => call("review", { id: request.id })));
  } catch (error) {
    showError(error);
  }
}

function scheduleResultDismissal() {
  clearTimeout(resultTimer);
  const activity = state.approvalActivity;
  if (!activity?.finishedAt || activity.status === "failed") return;
  const remaining = Math.max(0, activity.finishedAt + 2_500 - Date.now());
  resultTimer = setTimeout(() => {
    void call("dismiss-approval-result").then(update).then(prepareCurrentRequest).catch(showError);
  }, remaining);
}

function showError(error: unknown) {
  if (!app) return;
  app.querySelector(".popup-error")?.remove();
  app.append(
    errorMessage(error instanceof Error ? error.message : "Relay is unavailable."),
    ...(app.querySelector(".footer") ? [] : [footer()]),
  );
}

async function reconcile() {
  try {
    update(await call("refresh-approvals"));
    await prepareCurrentRequest();
  } catch (error) {
    showError(error);
  }
}

const port = chrome.runtime.connect({ name: "relay-status" });
port.onMessage.addListener((message) => {
  if (message?.type === "status-changed" && !document.hidden)
    void call("status").then(update).then(prepareCurrentRequest).catch(showError);
});
void call("status").then(update).then(reconcile).catch(showError);
