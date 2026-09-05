// SPDX-License-Identifier: AGPL-3.0-or-later
import { ago, brand, button, call, el, masked, statusBadge } from "./ui";

const app = document.getElementById("app");
async function render() {
  if (!app) return;
  try {
    const s = await call("status");
    app.replaceChildren(el("header", "popup-header", brand(), statusBadge(s.status)));
    if (s.phase !== "active") {
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
            `${s.workspace?.windows ?? 0} windows · ${s.workspace?.tabs ?? 0} tabs`,
          ),
          el(
            "p",
            "popup-meta",
            `${s.devices.filter((d) => d.online).length} devices connected · ${s.queue} queued`,
          ),
          el("small", "", `Last synced ${ago(s.lastSynced)}`),
        ),
      );
      if (s.approvals.length)
        app.append(
          el(
            "div",
            "banner approval-banner",
            el(
              "div",
              "",
              el("strong", "", "New device request"),
              el("small", "", `${s.approvals.length} waiting for review`),
            ),
            button("Review", () => void chrome.runtime.openOptionsPage(), "secondary compact"),
          ),
        );
      app.append(
        el(
          "nav",
          "popup-actions",
          button(
            s.paused ? "Resume Relay" : "Pause Relay",
            () => void call("pause", { value: !s.paused }).then(render).catch(showError),
            "secondary compact",
          ),
          button("Settings →", () => void chrome.runtime.openOptionsPage(), "ghost compact"),
        ),
        el(
          "div",
          "popup-account",
          el("span", "", "Account"),
          el("small", "", s.account ? masked(s.account) : ""),
        ),
      );
    }
    if (s.error) {
      const message = el("p", "error", s.error);
      message.setAttribute("role", "alert");
      app.append(message);
    }
    app.append(el("div", "footer", "End-to-end encrypted · Relay 1.0.0"));
  } catch (error) {
    showError(error);
  }
}
function showError(error: unknown) {
  const message = el(
    "p",
    "error",
    error instanceof Error ? error.message : "Relay is unavailable.",
  );
  message.setAttribute("role", "alert");
  app?.append(message);
}
void render();
