// SPDX-License-Identifier: AGPL-3.0-or-later
import { serverOrigin } from "@relay/shared";
import type { Status } from "./controller";
import {
  ago,
  brand,
  button,
  call,
  el,
  grouped,
  groupedCode,
  input,
  masked,
  statusBadge,
  switchControl,
} from "./ui";

declare const __DEV__: boolean;
declare const __REPOSITORY_URL__: string;
const app = document.getElementById("app");
let state: Status;
let screen = "welcome";
let section = "General";
let busy = false;
let lastView = "";
let revealed = false;
let nameValue = navigator.userAgent.includes("Windows")
  ? "Windows Desktop"
  : navigator.userAgent.includes("Mac")
    ? "Mac"
    : "Linux Desktop";
let serverValue = "";
let accountValue = "";
function report(error: unknown) {
  const old = document.getElementById("error");
  old?.remove();
  const message = errorMessage(
    error instanceof Error ? error.message : "Relay could not complete this action.",
  );
  const target = app?.querySelector<HTMLElement>(".onboarding, .grid > .section");
  if (target) target.prepend(message);
  else app?.append(message);
}

function errorMessage(text: string): HTMLElement {
  const message = el(
    "div",
    "error",
    el("span", "error-title", "Couldn’t complete that"),
    el("p", "", text),
  );
  message.id = "error";
  message.setAttribute("role", "alert");
  return message;
}
async function act(action: string, payload: Record<string, unknown> = {}) {
  if (busy) return;
  busy = true;
  try {
    state = await call(action, payload);
    screen = "welcome";
    render();
  } catch (error) {
    try {
      state = await call("status");
      render();
    } catch {
      // Keep the original action error if status itself cannot be refreshed.
    }
    report(error);
  } finally {
    busy = false;
  }
}
function saveRecovery() {
  const blob = new Blob(
    [
      `Relay recovery information\n\nServer: ${state.server}\nAccount: ${grouped(state.account ?? "")}\nRecovery key: ${state.recovery}\n\nKeep this file private. The recovery key authorizes new devices. Relay cannot recover it.\n`,
    ],
    { type: "text/plain" },
  );
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = "relay-recovery.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function controls() {
  const name = input("This device", nameValue);
  name.field.oninput = () => {
    nameValue = name.field.value;
  };
  const server = input("Relay server", serverValue || state.server);
  server.field.oninput = () => {
    serverValue = server.field.value;
  };
  const detail = el(
    "details",
    "server-disclosure",
    el("summary", "", state.official ? "Server settings" : "Choose a server"),
    server.wrapper,
    el(
      "small",
      "",
      state.official
        ? "Use the official origin or enter your own. Accounts belong to one server."
        : "No official service is configured in this build. Use a self-hosted server.",
    ),
  );
  if (__DEV__) detail.append(button("Test connection", () => void testConnection()));
  return el("div", "", name.wrapper, detail);
}
async function testConnection() {
  if (busy) return;
  busy = true;
  try {
    const origin = serverOrigin(serverValue || state.server, true);
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error("Server permission was denied. No connection was made.");
    const result = await call("health", { server: origin });
    state = await call("status");
    render();
    app?.append(el("p", result.ok ? "" : "error", result.message));
  } catch (error) {
    report(error);
  } finally {
    busy = false;
  }
}
async function withPermission(action: string, payload: Record<string, unknown>) {
  try {
    const origin = serverOrigin(serverValue || state.server, __DEV__);
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error("Server permission was denied. No connection was made.");
    await act(action, { server: origin, name: nameValue, ...payload });
  } catch (error) {
    report(error);
  }
}
function confirmation(
  label: string,
  onConfirm: () => void,
  buttonLabel: string,
  secondary?: HTMLElement,
) {
  const checkbox = el("input");
  checkbox.type = "checkbox";
  const submit = button(buttonLabel, onConfirm, "primary");
  submit.disabled = true;
  checkbox.onchange = () => {
    submit.disabled = !checkbox.checked;
  };
  const actions = el("div", "actions");
  if (secondary) actions.append(secondary);
  actions.append(submit);
  return el("div", "checks", el("label", "check-label", checkbox, el("span", "", label)), actions);
}
function onboarding(): HTMLElement {
  const welcome = state.phase === "welcome" && screen === "welcome";
  const body = el(
    "div",
    `onboarding section ${welcome ? "onboarding-welcome" : "onboarding-flow"}`,
  );
  if (state.phase === "draft" && state.recovery) {
    body.append(
      el("div", "eyebrow", "01 — Keep your recovery information"),
      el("h1", "", "Your Relay account"),
      el("div", "secret", grouped(state.account ?? "")),
      el(
        "p",
        "divider",
        "Use this number when adding another device. It is not your encryption key.",
      ),
      button(
        "Copy account number",
        () => void navigator.clipboard.writeText(state.account ?? "").catch(report),
      ),
      el("h2", "divider", "Save your recovery key"),
      el(
        "p",
        "",
        "It can authorize a device when none of your other devices are available. Relay cannot recover this key.",
      ),
    );
    if (revealed) body.append(el("div", "secret small", state.recovery));
    body.append(
      el(
        "div",
        "actions",
        button(revealed ? "Hide recovery key" : "Reveal recovery key", () => {
          revealed = !revealed;
          render();
        }),
        button(
          "Copy key",
          () => void navigator.clipboard.writeText(state.recovery ?? "").catch(report),
        ),
        button("Save recovery information", saveRecovery),
      ),
      el("h2", "divider", "Current workspace"),
      el(
        "p",
        "",
        `${state.stats.windows} windows · ${state.stats.tabs} syncable tabs · ${state.stats.local} local-only tabs`,
      ),
      confirmation(
        "I saved my recovery key and want to sync this workspace.",
        () => void act("start"),
        "Start syncing",
      ),
    );
    body.append(button("Cancel setup", () => void act("cancel")));
  } else if (state.phase === "pending" && screen !== "recover") {
    body.append(
      el("div", "eyebrow", "02 — Authorize this device"),
      el("h1", "", "Waiting for approval"),
      el(
        "p",
        "",
        "On an authorized device, open Relay → Devices → Review. No Relay device available? Keep this page open, or use your recovery key.",
      ),
    );
    if (state.pair?.sas)
      body.append(
        el("div", "eyebrow", "Verification code"),
        el("div", "code", groupedCode(state.pair.sas)),
        el(
          "p",
          "",
          "Compare this code on both devices. If they differ, cancel. Never approve a request you did not start.",
        ),
      );
    if (state.pair?.status === "approved")
      body.append(
        confirmation(
          "The code matches the device I approved.",
          () => void act("finish-pair", { code: state.pair?.sas }),
          "Finish authorization",
        ),
      );
    if (state.pair?.status === "expired")
      body.append(el("p", "error", "This approval request expired. Cancel and start again."));
    if (state.pair?.status === "denied")
      body.append(el("p", "error", "This request was denied. Cancel to try again."));
    body.append(
      el(
        "div",
        "actions",
        button("Use recovery key", () => {
          screen = "recover";
          render();
        }),
        button("Cancel", () => void act("cancel")),
      ),
    );
  } else if (state.phase === "merge") {
    body.append(
      el("div", "eyebrow", "03 — Bring your workspace together"),
      el("h1", "", "Relay workspace ready"),
      el(
        "p",
        "",
        `From Relay: ${state.workspace?.windows} windows · ${state.workspace?.tabs} tabs`,
      ),
      el(
        "p",
        "",
        `Already open here: ${state.stats.windows} windows · ${state.stats.tabs} syncable tabs`,
      ),
      el(
        "p",
        "",
        "Your existing tabs will be merged into Relay. Nothing already open here will be deleted.",
      ),
      button("Merge and continue", () => void act("merge"), "primary"),
    );
  } else if (screen === "join" || screen === "recover") {
    body.append(
      el("div", "eyebrow", screen === "join" ? "Already use Relay" : "Recovery"),
      el("h1", "", screen === "join" ? "Enter your account number" : "Use your recovery key"),
    );
    const account = input("24-digit account number", state.account ?? accountValue);
    account.field.className = "account-field";
    account.field.inputMode = "numeric";
    account.field.oninput = () => {
      accountValue = account.field.value;
    };
    body.append(account.wrapper, controls());
    if (screen === "recover") {
      const code = input("Recovery key", "", "password");
      code.field.className = "recovery-field";
      body.append(
        code.wrapper,
        el("p", "", "Your key is decrypted on this device. It is never sent to the server."),
        button(
          "Recover account",
          () =>
            void withPermission("recover", {
              account: account.field.value,
              code: code.field.value,
            }),
          "primary",
        ),
      );
    } else
      body.append(
        el(
          "div",
          "actions",
          button(
            "Request approval",
            () => void withPermission("join", { account: account.field.value }),
            "primary",
          ),
          button("Use recovery key", () => {
            screen = "recover";
            render();
          }),
        ),
      );
    body.append(
      el(
        "div",
        "actions",
        button("Back", () => {
          screen = "welcome";
          render();
        }),
      ),
    );
    if (state.phase === "draft") body.append(button("Cancel setup", () => void act("cancel")));
  } else {
    body.append(
      el("h1", "", "Your Helium workspace, everywhere."),
      el(
        "p",
        "",
        "Real-time synchronization between your devices. End-to-end encrypted. No email. No password.",
      ),
      controls(),
      el(
        "div",
        "actions onboarding-actions",
        button("Create Relay account", () => void withPermission("create", {}), "primary"),
        button("Enter account number", () => {
          screen = "join";
          render();
        }),
      ),
    );
  }
  return body;
}
function devicePanel() {
  const body = el(
    "div",
    "section",
    el("h2", "", "Devices"),
    el("p", "section-intro", "Friendly names are end-to-end encrypted."),
  );
  for (const pending of state.approvals) {
    const row = el("div", "banner device-request", el("div", "eyebrow", "New device request"));
    if (pending.sas) {
      row.append(
        el("div", "code", groupedCode(pending.sas)),
        confirmation(
          "I started this request and the codes match on both devices.",
          () => void act("approve", { id: pending.id, code: pending.sas }),
          "Approve",
          button("Deny", () => void act("deny", { id: pending.id }), "danger compact"),
        ),
      );
    } else {
      row.append(
        el(
          "p",
          "",
          pending.reviewing
            ? "Waiting for the pairing exchange. Keep both setup pages open."
            : "Verify the other device before allowing access.",
        ),
        el(
          "div",
          "actions",
          ...(!pending.reviewing
            ? [button("Review", () => void act("review", { id: pending.id }), "secondary compact")]
            : []),
          button("Deny", () => void act("deny", { id: pending.id }), "danger compact"),
        ),
      );
    }
    body.append(row);
  }
  for (const device of state.devices) {
    const row = el(
      "div",
      "row device-row",
      el(
        "div",
        "",
        el("h3", "", device.name),
        el(
          "small",
          "device-meta",
          device.id === state.device ? "This device · " : "",
          device.online ? "Online" : `Last seen ${ago(device.lastSeen)}`,
        ),
      ),
    );
    const actions = el(
      "div",
      "actions",
      button(
        "Rename",
        () => {
          const name = prompt("Device name", device.name);
          if (name?.trim()) void act("rename", { id: device.id, name });
        },
        "ghost compact",
      ),
    );
    if (device.id !== state.device)
      actions.append(
        button(
          "Revoke",
          () => {
            if (
              confirm(
                `Revoke ${device.name}? Relay will rotate its workspace key. Existing browser tabs will not be closed.`,
              )
            )
              void act("revoke", { id: device.id });
          },
          "danger compact",
        ),
      );
    row.append(actions);
    body.append(row);
  }
  return body;
}
function preferenceRow(
  name: string,
  description: string,
  key: keyof Status["preferences"],
  unavailable = false,
  note?: string,
) {
  const copy = el("div", "preference-copy", el("h3", "", name), el("small", "", description));
  if (note) copy.append(el("small", "preference-note", note));
  const row = el("div", "row preference-row", copy);
  row.append(
    switchControl(name, !!state.preferences[key], unavailable, (checked) => {
      void act("preferences", { preferences: { [key]: checked } });
    }),
  );
  return row;
}
function settings() {
  const nav = el("nav", "nav");
  nav.setAttribute("aria-label", "Settings");
  for (const name of ["General", "Synchronization", "Devices", "Security", "Server", "About"]) {
    const b = button(name, () => {
      section = name;
      render();
    });
    if (section === name) b.setAttribute("aria-current", "page");
    nav.append(b);
  }
  let content = el("div", "section", el("h2", "", section));
  if (section === "General")
    content.append(
      statusBadge(state.status),
      el("h3", "divider", "Main workspace"),
      el("p", "metric", `${state.workspace?.windows} windows · ${state.workspace?.tabs} tabs`),
      el("p", "", `Last synced ${ago(state.lastSynced)} · ${state.queue} local changes queued`),
      el(
        "div",
        "actions",
        button(
          state.paused ? "Resume Relay" : "Pause Relay",
          () => void act("pause", { value: !state.paused }),
          "primary",
        ),
        button("Reconnect", () => void act("retry")),
      ),
      el(
        "p",
        "",
        "Active tabs and window positions stay local. Pausing disconnects Relay; workspace changes made while paused are queued for resume.",
      ),
    );
  if (section === "Synchronization")
    content.append(
      el(
        "p",
        "section-intro",
        "Choose which workspace changes this device shares with your other Relay devices.",
      ),
      el("h3", "section-label", "Tabs"),
      preferenceRow("New tabs", "Add newly opened tabs to Relay.", "tabCreation"),
      preferenceRow(
        "Close tabs",
        "Close synced tabs on your other devices.",
        "tabClosure",
        true,
        "Coming later: local dismissal needs a durable per-device projection state.",
      ),
      preferenceRow("Navigation", "Keep synchronized tabs on the same URL.", "navigation"),
      el("h3", "section-label divided-label", "Organization"),
      preferenceRow(
        "Tab groups",
        "Sync group names, colors, and tab membership.",
        "tabGroups",
        !state.capabilities.tabGroups,
        !state.capabilities.tabGroups
          ? "This browser does not expose the required tab-group APIs."
          : undefined,
      ),
      preferenceRow("Pinned tabs", "Keep pinned and unpinned state synchronized.", "pinnedTabs"),
      preferenceRow(
        "Multiple windows",
        "Recreate Relay's separate browser windows on this device.",
        "multipleWindows",
        true,
        "Coming later: flattening is deferred to protect window lifecycle reconciliation.",
      ),
      el(
        "div",
        "sync-boundaries",
        el(
          "div",
          "",
          el("h3", "", "Always stays local"),
          el("p", "", "Active tab, window focus, window size and position, group collapsed state."),
        ),
        el(
          "div",
          "",
          el("h3", "", "Never synchronized"),
          el("p", "", "Incognito, local files, and protected browser pages."),
        ),
      ),
    );
  if (section === "Devices") content = devicePanel();
  if (section === "Security") {
    content.append(
      el("h3", "divider", "Account number"),
      el(
        "div",
        "secret account-number",
        revealed ? grouped(state.account ?? "") : masked(state.account ?? ""),
      ),
      el(
        "div",
        "actions",
        button(revealed ? "Hide" : "Reveal", () => {
          revealed = !revealed;
          render();
        }),
        button(
          "Copy account number",
          () => void navigator.clipboard.writeText(state.account ?? "").catch(report),
        ),
      ),
      el("h3", "divider", "Encrypted on your device"),
      el(
        "p",
        "",
        `AES-256-GCM protects workspace contents. Current key epoch: ${state.epoch}. Revoking a device changes the workspace key for future data.`,
      ),
      el("h3", "divider", "Recovery"),
      el(
        "p",
        "",
        "Use the recovery information you saved during setup. Relay cannot retrieve it. Recovery key replacement is not available in this early v1 build.",
      ),
    );
  }
  if (section === "Server")
    content.append(
      el(
        "h3",
        "divider",
        state.server === state.official ? "Relay · Official service" : "Custom server",
      ),
      el("p", "", state.server),
      statusBadge(state.status),
      el(
        "p",
        "divider",
        "Accounts and encrypted workspaces belong to one server. Changing servers is not an account migration. Use a separate browser profile for another server; this build locks the origin after setup to avoid mixing account state.",
      ),
    );
  if (section === "About") {
    content.append(
      brand(),
      el("p", "", "Relay 1.0.0 · Early v1 development build"),
      el("p", "", state.groups),
      el("p", "", "Built for Helium. Works with compatible Chromium browsers."),
      el(
        "p",
        "",
        "Relay is an independent project and is not affiliated with or endorsed by Helium.",
      ),
      el(
        "p",
        "",
        "Source code: AGPL-3.0-or-later. Relay is a working product name. Security review and cross-platform manual testing are required before public release.",
      ),
      el("h3", "divider", "Privacy"),
      el(
        "p",
        "",
        "No telemetry, ads, browsing analytics, or sale of data. The server sees public keys, opaque IDs, connection metadata and ciphertext—not readable URLs, device names, recovery keys or workspace keys.",
      ),
    );
    if (__REPOSITORY_URL__) {
      const link = el("a", "", "Source and documentation ↗");
      link.href = __REPOSITORY_URL__;
      link.target = "_blank";
      link.rel = "noreferrer";
      content.append(link);
    } else
      content.append(el("small", "", "A public source repository URL has not been configured."));
  }
  if (__DEV__ && section === "General") {
    const development = el(
      "details",
      "development",
      el("summary", "", "Development"),
      el("h3", "", "Connection diagnostics"),
      el(
        "p",
        "",
        "Inspect the local server connection and development-only synchronization details.",
      ),
      button("Test connection", () => void testConnection(), "secondary compact"),
    );
    if (state.diagnostics)
      development.append(
        el(
          "p",
          "development-meta",
          `${state.diagnostics.operations} local operations · ${state.diagnostics.reconnects} connections · ${state.diagnostics.snapshotBytes} snapshot bytes · revision ${state.revision}`,
        ),
      );
    if (state.startTrace?.length) development.append(el("pre", "", state.startTrace.join("\n")));
    if (state.behavior)
      development.append(
        el("pre", "", JSON.stringify({ lifecycle: state.lifecycle, ...state.behavior }, null, 2)),
      );
    content.append(development);
  }
  return el("div", "grid", nav, content);
}
function render() {
  if (!app) return;
  // A join/recovery draft has no newly generated recovery key. Keep it retryable,
  // including after a settings-page reload, instead of offering Start syncing.
  if (state.phase === "draft" && !state.recovery && screen === "welcome") screen = "join";
  app.className = "shell";
  app.classList.toggle("onboarding-shell", state.phase !== "active");
  app.classList.toggle(
    "onboarding-welcome-shell",
    state.phase === "welcome" && screen === "welcome",
  );
  app.replaceChildren(brand());
  const page = state.phase === "active" ? settings() : onboarding();
  if (state.error) {
    const errorTarget =
      state.phase === "active" ? page.querySelector<HTMLElement>(".section") : page;
    (errorTarget ?? page).prepend(errorMessage(state.error));
  }
  app.append(page);
  app.append(
    el(
      "footer",
      "footer",
      "Relay is an independent project, not affiliated with or endorsed by Helium. Your active tab and window layout stay yours.",
    ),
  );
  lastView = JSON.stringify(state);
}
async function refresh() {
  if (busy || document.hidden) return;
  try {
    const next = await call("status", { poll: state?.phase === "pending" });
    const changed = JSON.stringify(next) !== lastView;
    state = next;
    if (changed && document.activeElement?.tagName !== "INPUT") render();
  } catch (error) {
    report(error);
  }
}
void call("status")
  .then((value) => {
    state = value;
    serverValue = value.server;
    render();
    setInterval(() => void refresh(), 3000);
  })
  .catch(report);
