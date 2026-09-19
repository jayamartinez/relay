// SPDX-License-Identifier: AGPL-3.0-or-later

import { adjacentApprovalId, approvalPosition, currentApproval, SingleFlight } from "./approval-ui";
import { formatRelayBuild } from "./build-info";
import type { Status } from "./controller";
import { watchStatus } from "./status-channel";
import { statusViewKey } from "./status-view";
import { ago, brand, button, call, countLabel, el, groupedCode, masked, statusBadge } from "./ui";

declare const __PRODUCT_VERSION__: string;
declare const __BUILD_ID__: string;
const app = document.getElementById("app");
const requests = new SingleFlight();
let state: Status;
let selectedId: string | undefined;
let localError: string | undefined;
let localAction: "approve" | "deny" | undefined;
let resultTimer: ReturnType<typeof setTimeout> | undefined;

function footer() {
  return el(
    "div",
    "footer",
    `End-to-end encrypted · ${formatRelayBuild(__PRODUCT_VERSION__, __BUILD_ID__)}`,
  );
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

function settingsControl() {
  return button(
    "Settings →",
    () => void chrome.runtime.openOptionsPage().catch(showError),
    "ghost compact",
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
                activity.action === "approve" ? "Review again" : "Retry",
                () =>
                  void (activity.action === "approve"
                    ? dismissResult()
                    : runApproval(activity.action, activity.requestId)),
                "primary compact",
              ),
            ),
          ]
        : []),
      button("Back", () => void dismissResult(), "ghost compact"),
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
  if (state.paused) {
    section.append(
      el(
        "p",
        "popup-approval-copy popup-preparing",
        "Relay is paused. Resume to review this device request.",
      ),
      button(
        "Resume Relay",
        () => {
          localError = undefined;
          void requests
            .run("pause", () => call("pause", { value: false }))
            .then(update)
            .then(prepareCurrentRequest)
            .catch(showError);
        },
        "secondary compact",
      ),
    );
    return section;
  }
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
  if (!app) return;
  clearTimeout(resultTimer);
  if (!state) {
    app.replaceChildren(
      approvalHeader("Not connected"),
      errorMessage(localError ?? "Relay background worker is unavailable."),
      el(
        "nav",
        "popup-actions",
        button("Retry", () => void load(), "secondary compact"),
        settingsControl(),
      ),
      footer(),
    );
    return;
  }
  const actionResult = resultView();
  const failure =
    state.approvalActivity?.status === "failed" ? undefined : localError || state.error;
  const approval = actionResult ?? pendingView();
  app.replaceChildren(approvalHeader(approval || failure ? "Needs attention" : state.status));
  if (failure) app.append(errorMessage(failure));
  if (approval) {
    app.append(approval, settingsControl(), footer());
    scheduleResultDismissal();
    return;
  }
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
        settingsControl(),
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
