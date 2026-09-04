// SPDX-License-Identifier: AGPL-3.0-or-later
import { ago, brand, button, call, el, masked } from "./ui";

const app = document.getElementById("app");
async function render() {
  if (!app) return;
  try {
    const s = await call("status");
    app.replaceChildren(brand(), el("div", "status", s.status));
    if (s.phase !== "active") {
      app.append(
        el("h2", "divider", "Your workspace, everywhere."),
        el("p", "", "End-to-end encrypted. No email. No password."),
        button("Set up Relay", () => void chrome.runtime.openOptionsPage(), "primary full"),
      );
    } else {
      app.append(
        el("h2", "divider", "Main workspace"),
        el("p", "metric", `${s.workspace?.windows ?? 0} windows · ${s.workspace?.tabs ?? 0} tabs`),
        el(
          "p",
          "",
          `${s.devices.filter((d) => d.online).length} devices connected · ${s.queue} queued`,
        ),
        el("small", "", `Last synced ${ago(s.lastSynced)}`),
      );
      if (s.approvals.length)
        app.append(
          el(
            "div",
            "banner",
            `${s.approvals.length} device wants to join`,
            button("Review", () => void chrome.runtime.openOptionsPage()),
          ),
        );
      app.append(
        el(
          "div",
          "actions",
          button(
            s.paused ? "Resume Relay" : "Pause Relay",
            () => void call("pause", { value: !s.paused }).then(render).catch(showError),
          ),
        ),
        el("small", "", s.account ? masked(s.account) : ""),
        button("Settings →", () => void chrome.runtime.openOptionsPage(), "full"),
      );
    }
    if (s.error) app.append(el("p", "error", s.error));
    app.append(el("div", "footer", "End-to-end encrypted · Relay 1.0.0"));
  } catch (error) {
    showError(error);
  }
}
function showError(error: unknown) {
  app?.append(el("p", "error", error instanceof Error ? error.message : "Relay is unavailable."));
}
void render();
