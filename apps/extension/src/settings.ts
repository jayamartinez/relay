// SPDX-License-Identifier: AGPL-3.0-or-later
import { serverOrigin } from "@relay/shared";
import { displayBuildId } from "./build-info";
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
  grouped,
  groupedCode,
  type IconName,
  icon,
  input,
  mark,
  masked,
  statusBadge,
  switchControl,
  syncedLabel,
  toneFor,
} from "./ui";

declare const __DEV__: boolean;
declare const __REPOSITORY_URL__: string;
declare const __PRODUCT_VERSION__: string;
declare const __BUILD_ID__: string;
const app = document.getElementById("app");
let state: Status;
let screen = "welcome";
let section = "General";
let busy = false;
let lastView = "";
let refreshing = false;
let lastAttention = "";
let lastContext = "";
let revealed = false;
let renaming: string | undefined;
let renameValue = "";
let revoking: string | undefined;
let nameValue = navigator.userAgent.includes("Windows")
  ? "Windows Desktop"
  : navigator.userAgent.includes("Mac")
    ? "Mac"
    : "Linux Desktop";
let serverValue = "";
let accountValue = "";

function errorTarget() {
  return app?.querySelector<HTMLElement>("[data-error-target]") ?? app;
}

function report(error: unknown) {
  document.getElementById("error")?.remove();
  const message = errorMessage(
    error instanceof Error ? error.message : "Relay could not complete this action.",
  );
  const target = app?.querySelector<HTMLElement>("[data-error-target]");
  if (target) target.prepend(message);
  else app?.append(message);
}

function errorMessage(text: string): HTMLElement {
  const message = alertMessage(text);
  message.id = "error";
  return message;
}

async function perform(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  const controls = Array.from(
    app?.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input") ?? [],
  ).filter((control) => !control.disabled);
  for (const control of controls) control.disabled = true;
  app?.setAttribute("aria-busy", "true");
  try {
    await action();
  } catch (error) {
    try {
      state = await call("status");
      render();
    } catch {
      // Keep the original action error if status itself cannot be refreshed.
      if (state) render();
    }
    report(error);
  } finally {
    busy = false;
    for (const control of controls) control.disabled = false;
    app?.setAttribute("aria-busy", "false");
  }
}

async function act(action: string, payload: Record<string, unknown> = {}) {
  await perform(async () => {
    state = await call(action, payload);
    screen = "welcome";
    render();
  });
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

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(report);
}

// ─── Building blocks ────────────────────────────────────────────────────

function pageHeader(title: string, description?: string, level: "h1" | "h2" = "h2") {
  return el(
    "div",
    "rl-page-header",
    el(level, "rl-title", title),
    description ? el("p", "rl-text", description) : undefined,
  );
}

function sectionBlock(label: string | undefined, ...children: (HTMLElement | undefined)[]) {
  return el(
    "section",
    "rl-section",
    label ? el("h3", "rl-section-label", label) : undefined,
    ...children,
  );
}

function group(...children: (HTMLElement | undefined)[]) {
  return el("div", "rl-group", ...children);
}

function row(title: string, description?: string, ...aside: (HTMLElement | undefined)[]) {
  return el(
    "div",
    "rl-row",
    el(
      "div",
      "rl-row-copy",
      el("span", "rl-row-title", title),
      description ? el("span", "rl-row-desc", description) : undefined,
    ),
    ...aside,
  );
}

function valueRow(title: string, value: string) {
  return row(title, undefined, el("span", "rl-row-value", value));
}

function dot(online: boolean) {
  const light = el("span", "rl-dot");
  light.dataset.state = online ? "online" : "offline";
  return el("span", "rl-dot-slot", light);
}

function checkbox(label: string, onChange: (checked: boolean) => void) {
  const box = el("input");
  box.type = "checkbox";
  box.onchange = () => onChange(box.checked);
  return el("label", "rl-check", box, el("span", "", label));
}

function confirmation(
  label: string,
  onConfirm: () => void,
  buttonLabel: string,
  ...secondary: HTMLElement[]
) {
  const submit = button(buttonLabel, onConfirm, "rl-btn rl-btn--primary rl-btn--lg");
  submit.disabled = true;
  const check = checkbox(label, (checked) => {
    submit.disabled = !checked;
  });
  return el(
    "div",
    "rl-section",
    check,
    el("div", "rl-actions rl-actions--split", submit, ...secondary),
  );
}

function serverPresentation() {
  const hosted = !!state.official && state.server === state.official;
  if (hosted && state.channel === "production")
    return { name: "Relay server", description: "Official Relay service" };
  if (hosted)
    return {
      name: "Relay staging server",
      description: "Staging service for release validation",
    };
  if (
    state.channel === "development" &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(state.server)
  )
    return {
      name: "Development server",
      description: "Local Relay service for development",
    };
  return {
    name: "Custom / self-hosted server",
    description: "This browser profile is connected to a non-production Relay origin.",
  };
}

function setupControls() {
  const name = input("This device", nameValue);
  name.field.oninput = () => {
    nameValue = name.field.value;
  };
  const device = el(
    "div",
    "rl-field",
    name.wrapper,
    el(
      "span",
      "rl-field-help",
      "Shown to your other devices. Encrypted before it leaves this browser.",
    ),
  );
  const server = input("Relay server", serverValue || state.server);
  server.field.oninput = () => {
    serverValue = server.field.value;
  };
  const official = !!state.official && (serverValue || state.server) === state.official;
  const disclosure = el(
    "details",
    "rl-disclosure server-disclosure",
    el(
      "summary",
      "",
      el("span", "", state.official ? "Server settings" : "Choose a server"),
      el(
        "span",
        "rl-disclosure-meta",
        official ? "Official Relay service" : serverValue || state.server || "Not set",
        icon("chevron"),
      ),
    ),
    el(
      "div",
      "rl-disclosure-body",
      server.wrapper,
      el(
        "span",
        "rl-field-help",
        state.official
          ? "Use the official server or enter your own. Accounts belong to one server."
          : "No official service is configured in this build. Use a self-hosted server.",
      ),
    ),
  );
  return { device, disclosure };
}

async function testConnection() {
  await perform(async () => {
    const origin = serverOrigin(serverValue || state.server, true);
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error("Server permission was denied. No connection was made.");
    const result = await call("health", { server: origin });
    state = await call("status");
    render();
    errorTarget()?.append(el("p", result.ok ? "rl-inline-ok" : "rl-inline-error", result.message));
  });
}

async function withPermission(action: string, payload: Record<string, unknown>) {
  await perform(async () => {
    const origin = serverOrigin(serverValue || state.server, __DEV__);
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error("Server permission was denied. No connection was made.");
    state = await call(action, { server: origin, name: nameValue, ...payload });
    screen = "welcome";
    render();
  });
}

// ─── Setup ──────────────────────────────────────────────────────────────

function setupLabel() {
  if (state.phase === "draft" && state.recovery) return "Setup · New account";
  if (state.phase === "pending" || state.phase === "merge" || screen === "join")
    return "Setup · Join";
  if (screen === "recover") return "Setup · Recovery";
  return "Setup";
}

function heading(title: string, lede?: string, large = false) {
  return el(
    "div",
    "rl-setup-heading",
    el("h1", `rl-title${large ? " rl-title--xl" : ""}`, title),
    lede ? el("p", "rl-lede", lede) : undefined,
  );
}

function backButton(onClick: () => void) {
  return button([icon("back"), "Back"], onClick, "rl-back");
}

function draftView(column: HTMLElement) {
  const accountHead = el(
    "div",
    "rl-row-head rl-row-head--flush",
    el("span", "rl-section-label", "Account number"),
    button("Copy account number", () => copy(state.account ?? ""), "rl-btn rl-btn--sm"),
  );
  const recoveryHead = el(
    "div",
    "rl-row-head rl-row-head--flush",
    el("span", "rl-section-label", "Recovery key"),
    el(
      "div",
      "rl-row-actions",
      button(
        revealed ? "Hide recovery key" : "Reveal recovery key",
        () => {
          revealed = !revealed;
          render();
        },
        "rl-btn rl-btn--sm",
      ),
      button("Copy key", () => copy(state.recovery ?? ""), "rl-btn rl-btn--sm"),
    ),
  );
  column.append(
    heading(
      "Your Relay account",
      "Save your recovery key before you start. It can authorize a new device when none of your others are available, and Relay can’t recover it for you.",
    ),
    group(
      el(
        "div",
        "rl-group-pad",
        accountHead,
        el("div", "rl-secret", grouped(state.account ?? "")),
        el(
          "span",
          "rl-field-help",
          "Enter this on another device to join. It isn’t your encryption key.",
        ),
      ),
      el(
        "div",
        "rl-group-pad",
        recoveryHead,
        revealed
          ? el("div", "rl-secret rl-secret--key", state.recovery ?? "")
          : el("div", "rl-secret--hidden", "•••••• •••••• •••••• •••••• ••••••"),
        el(
          "div",
          "rl-actions",
          button([icon("download"), "Save recovery information"], saveRecovery, "rl-link"),
          el("span", "rl-caption", "relay-recovery.txt"),
        ),
      ),
    ),
    el(
      "p",
      "rl-meta",
      icon("window"),
      `This browser: ${countLabel(state.stats.windows, "window")} · ${countLabel(state.stats.tabs, "syncable tab")} · ${countLabel(state.stats.local, "local-only tab")}`,
    ),
    confirmation(
      "I saved my recovery key and want to sync this workspace.",
      () => void act("start"),
      "Start syncing",
      button("Cancel setup", () => void act("cancel"), "rl-btn rl-btn--ghost"),
    ),
  );
}

function pendingView(column: HTMLElement) {
  const code = state.pair?.sas;
  const pairStatus = state.pair?.status;
  const minutes = state.pair?.expires
    ? Math.max(0, Math.ceil((state.pair.expires - Date.now()) / 60_000))
    : 0;
  const approved = pairStatus === "approved";
  const [statusLabel, lightTone] =
    pairStatus === "expired"
      ? (["Request expired", "offline"] as const)
      : pairStatus === "denied"
        ? (["Request denied", "offline"] as const)
        : approved
          ? (["Approved on another device", "live"] as const)
          : (["Waiting for approval", "attention"] as const);
  const head = el(
    "div",
    "rl-row-head",
    el("div", "", statusBadge(statusLabel, lightTone)),
    pairStatus === "pending" || approved
      ? el("span", "rl-caption", `Expires in ${countLabel(minutes, "min", "min")}`)
      : undefined,
  );
  const approvalGroup = group(head);
  if (code)
    approvalGroup.append(
      el(
        "div",
        "rl-code-well rl-code-well--flat",
        el("span", "rl-caption", "Verification code"),
        el("span", "rl-code rl-code--lg", groupedCode(code)),
        el(
          "p",
          "rl-small",
          "Compare this code on both devices. If they differ, cancel. Never approve a request you did not start.",
        ),
      ),
    );
  else if (pairStatus === "pending")
    approvalGroup.append(
      el(
        "div",
        "rl-group-pad",
        el(
          "p",
          "rl-small",
          "No Relay device available? Keep this page open, or use your recovery key.",
        ),
      ),
    );
  if (pairStatus === "expired")
    approvalGroup.append(
      el(
        "div",
        "rl-group-pad",
        el("p", "rl-inline-error", "This approval request expired. Cancel and start again."),
      ),
    );
  if (pairStatus === "denied")
    approvalGroup.append(
      el(
        "div",
        "rl-group-pad",
        el("p", "rl-inline-error", "This request was denied. Cancel to try again."),
      ),
    );
  const actions = el("div", "rl-actions");
  if (approved && code) {
    const submit = button(
      "Finish authorization",
      () => void act("finish-pair", { code }),
      "rl-btn rl-btn--primary rl-btn--lg",
    );
    submit.disabled = true;
    approvalGroup.append(
      el(
        "div",
        "rl-group-pad",
        checkbox("The code matches the device I approved.", (checked) => {
          submit.disabled = !checked;
        }),
      ),
    );
    actions.append(submit);
  }
  actions.append(
    button(
      "Use recovery key",
      () => {
        screen = "recover";
        render();
      },
      "rl-btn rl-btn--lg",
    ),
    button("Cancel", () => void act("cancel"), "rl-btn rl-btn--ghost rl-btn--lg"),
  );
  actions.classList.add("rl-actions--split");
  column.append(
    heading(
      "Waiting for approval",
      "Open Relay on one of your other devices and approve this request. Keep this page open.",
    ),
    approvalGroup,
    actions,
  );
}

function mergeView(column: HTMLElement) {
  const tile = (graphic: Element, tone: "signal" | "neutral") => {
    const wrap = el("span", "rl-summary-light");
    wrap.dataset.tone = tone;
    wrap.append(graphic);
    return wrap;
  };
  column.append(
    heading(
      "Relay workspace ready",
      "Your Relay tabs will open alongside what’s already here. Nothing open on this device is closed.",
    ),
    group(
      el(
        "div",
        "rl-summary",
        tile(mark("rl-mark"), "signal"),
        el(
          "div",
          "rl-summary-copy",
          el("span", "rl-row-title", "From Relay"),
          el("span", "rl-row-desc", "Your synced workspace"),
        ),
        el(
          "span",
          "rl-row-title",
          `${countLabel(state.workspace?.windows ?? 0, "window")} · ${countLabel(state.workspace?.tabs ?? 0, "tab")}`,
        ),
      ),
      el(
        "div",
        "rl-summary",
        tile(icon("window"), "neutral"),
        el(
          "div",
          "rl-summary-copy",
          el("span", "rl-row-title", "Already open here"),
          el("span", "rl-row-desc", "Kept, and added to Relay"),
        ),
        el(
          "span",
          "rl-row-title",
          `${countLabel(state.stats.windows, "window")} · ${countLabel(state.stats.tabs, "syncable tab")}`,
        ),
      ),
    ),
    el(
      "div",
      "rl-actions",
      button("Merge and continue", () => void act("merge"), "rl-btn rl-btn--primary rl-btn--lg"),
    ),
  );
}

function joinView(column: HTMLElement) {
  const recovering = screen === "recover";
  const { device, disclosure } = setupControls();
  const account = input(
    "24-digit account number",
    state.account ?? accountValue,
    "text",
    "rl-input rl-input--number account-field",
  );
  account.field.inputMode = "numeric";
  account.field.oninput = () => {
    accountValue = account.field.value;
  };
  const fields = el("div", "rl-group-pad", account.wrapper);
  const actions = el("div", "rl-actions");
  if (recovering) {
    const code = input("Recovery key", "", "password", "rl-input recovery-field");
    fields.append(code.wrapper);
    actions.append(
      button(
        "Recover account",
        () =>
          void withPermission("recover", {
            account: account.field.value,
            code: code.field.value,
          }),
        "rl-btn rl-btn--primary rl-btn--lg",
      ),
    );
  } else
    actions.append(
      button(
        "Request approval",
        () => void withPermission("join", { account: account.field.value }),
        "rl-btn rl-btn--primary rl-btn--lg",
      ),
      button(
        "Use recovery key",
        () => {
          screen = "recover";
          render();
        },
        "rl-btn rl-btn--lg",
      ),
    );
  if (state.phase === "draft") {
    actions.classList.add("rl-actions--split");
    actions.append(
      button("Cancel setup", () => void act("cancel"), "rl-btn rl-btn--ghost rl-btn--lg"),
    );
  }
  fields.append(device);
  column.append(
    backButton(() => {
      screen = "welcome";
      render();
    }),
    heading(
      recovering ? "Use your recovery key" : "Enter your account number",
      recovering
        ? "For when none of your other devices are available. Your key is decrypted on this device and never sent to the server."
        : "You’ll find it in Relay → Security on a device you already use. That device will be asked to approve this one.",
    ),
    group(fields, disclosure),
    actions,
  );
}

function welcomeView(column: HTMLElement) {
  const { device, disclosure } = setupControls();
  column.append(
    heading(
      "Your Helium workspace, everywhere.",
      "Keep tabs, windows, and tab groups in sync across your devices. End‑to‑end encrypted. No email. No password.",
      true,
    ),
    group(el("div", "rl-group-pad", device), disclosure),
    el(
      "div",
      "rl-actions onboarding-actions",
      button(
        "Create Relay account",
        () => void withPermission("create", {}),
        "rl-btn rl-btn--primary rl-btn--lg",
      ),
      button(
        "Enter account number",
        () => {
          screen = "join";
          render();
        },
        "rl-btn rl-btn--lg",
      ),
    ),
  );
}

function onboarding(): HTMLElement {
  const column = el("div", "rl-setup-column");
  column.dataset.errorTarget = "";
  if (state.phase === "draft" && state.recovery) {
    column.classList.add("rl-setup-column--wide");
    draftView(column);
  } else if (state.phase === "pending" && screen !== "recover") pendingView(column);
  else if (state.phase === "merge") mergeView(column);
  else if (screen === "join" || screen === "recover") joinView(column);
  else welcomeView(column);
  return el(
    "div",
    "rl-setup",
    el("header", "rl-setup-bar", brand(true), el("span", "rl-small", setupLabel())),
    el("div", "rl-setup-stage", column),
    el(
      "footer",
      "rl-setup-footer",
      el(
        "span",
        "rl-caption",
        "Relay is an independent project, not affiliated with or endorsed by Helium.",
      ),
      el("span", "rl-caption", "Your active tab and window layout stay yours."),
    ),
  );
}

// ─── Settings pages ─────────────────────────────────────────────────────

function generalPage(column: HTMLElement) {
  const live = state.status === "Live" && !state.paused;
  const online = state.devices.filter((device) => device.online).length;
  const light = el("span", "rl-summary-light", statusBadge("", toneFor(state.status)));
  light.firstElementChild?.removeAttribute("role");
  column.append(
    pageHeader(
      "General",
      "Relay keeps this browser’s tabs, windows, and groups in step with your other devices.",
    ),
    group(
      el(
        "div",
        "rl-summary",
        light,
        el(
          "div",
          "rl-summary-copy",
          el("span", "rl-summary-strong", state.status),
          el(
            "span",
            "rl-small",
            [
              syncedLabel(state.lastSynced, live),
              state.devices.length
                ? `${online} of ${countLabel(state.devices.length, "device")} online`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
        el(
          "div",
          "rl-summary-aside",
          el(
            "span",
            "rl-summary-strong",
            `${countLabel(state.workspace?.windows ?? 0, "window")} · ${countLabel(state.workspace?.tabs ?? 0, "tab")}`,
          ),
          el("span", "rl-small", "Main workspace"),
        ),
      ),
      state.queue
        ? el(
            "div",
            "rl-group-pad",
            el("span", "rl-small", `${countLabel(state.queue, "local change")} waiting to sync.`),
          )
        : undefined,
    ),
    sectionBlock(
      "Sync",
      group(
        row(
          state.paused ? "Relay is paused" : "Pause Relay",
          state.paused
            ? "Changes made while paused are kept and sent when you resume."
            : "Stop sending and receiving changes. Changes made while paused are kept and sent when you resume.",
          button(
            state.paused ? "Resume Relay" : "Pause Relay",
            () => void act("pause", { value: !state.paused }),
            `rl-btn rl-btn--sm${state.paused ? " rl-btn--primary" : ""}`,
          ),
        ),
        row(
          "Reconnect",
          "Open a fresh connection to the Relay server.",
          button("Reconnect", () => void act("retry"), "rl-btn rl-btn--sm"),
        ),
      ),
    ),
    el("p", "rl-note", "The active tab and window positions always stay on each device."),
  );
  if (__DEV__) column.append(developmentPanel());
}

function developmentPanel() {
  const development = el(
    "details",
    "rl-dev",
    el("summary", "", "Development"),
    el(
      "div",
      "rl-section",
      el(
        "p",
        "rl-small",
        "Inspect the local server connection and development-only synchronization details.",
      ),
      el(
        "div",
        "rl-actions",
        button("Test connection", () => void testConnection(), "rl-btn rl-btn--sm"),
      ),
    ),
  );
  const body = development.lastElementChild as HTMLElement;
  if (state.diagnostics)
    body.append(
      el(
        "p",
        "rl-caption",
        `${state.diagnostics.operations} local operations · ${state.diagnostics.reconnects} connections · ${state.diagnostics.snapshotBytes} snapshot bytes · revision ${state.revision}`,
      ),
    );
  if (state.startTrace?.length) body.append(el("pre", "", state.startTrace.join("\n")));
  if (state.runtime || state.behavior) {
    const diagnostics = JSON.stringify(
      { runtime: state.runtime, behavior: state.behavior },
      null,
      2,
    );
    body.append(
      el(
        "div",
        "rl-actions",
        button("Copy diagnostics", () => copy(diagnostics), "rl-btn rl-btn--sm"),
      ),
      el("pre", "", diagnostics),
    );
  }
  return development;
}

function preferenceRow(
  name: string,
  description: string,
  key: keyof Status["preferences"],
  unavailable = false,
  note?: string,
) {
  const line = row(
    name,
    note ? `${description} ${note}` : description,
    switchControl(name, !!state.preferences[key], unavailable, (checked) => {
      void act("preferences", { preferences: { [key]: checked } });
    }),
  );
  if (unavailable) line.dataset.disabled = "";
  return line;
}

function synchronizationPage(column: HTMLElement) {
  column.append(
    pageHeader(
      "Synchronization",
      "Choose which changes this device shares with your other Relay devices.",
    ),
    sectionBlock(
      "Tabs",
      group(
        preferenceRow("New tabs", "Add newly opened tabs to Relay.", "tabCreation"),
        preferenceRow(
          "Close tabs",
          "Close synced tabs on your other devices.",
          "tabClosure",
          true,
          "Not available yet.",
        ),
        preferenceRow("Navigation", "Keep synchronized tabs on the same page.", "navigation"),
      ),
    ),
    sectionBlock(
      "Organization",
      group(
        preferenceRow(
          "Tab groups",
          "Sync group names, colors, and tab membership.",
          "tabGroups",
          !state.capabilities.tabGroups,
          !state.capabilities.tabGroups
            ? "This browser doesn’t provide the tab group APIs Relay needs."
            : undefined,
        ),
        preferenceRow("Pinned tabs", "Keep pinned and unpinned state synchronized.", "pinnedTabs"),
        preferenceRow(
          "Multiple windows",
          "Recreate Relay’s separate windows on this device.",
          "multipleWindows",
          true,
          "Not available yet.",
        ),
      ),
    ),
    el(
      "div",
      "rl-facts",
      el(
        "div",
        "",
        el("h3", "", "Always stays on this device"),
        el(
          "p",
          "rl-small",
          "Active tab, window focus, window size and position, collapsed groups.",
        ),
      ),
      el(
        "div",
        "",
        el("h3", "", "Never synchronized"),
        el("p", "rl-small", "Incognito, local files, and protected browser pages."),
      ),
    ),
  );
}

function requestGroup(pending: Status["approvals"][number]) {
  const head = el(
    "div",
    "rl-row-head",
    el("div", "", statusBadge("New device request", "attention")),
    el("span", "rl-caption", `Requested ${ago(pending.requestedAt).toLowerCase()}`),
  );
  head.querySelector(".rl-status")?.setAttribute("role", "presentation");
  const requestGroupElement = group(head);
  requestGroupElement.classList.add("rl-group--attention");
  if (pending.sas) {
    const code = pending.sas;
    const approve = button(
      "Approve",
      () => void act("approve", { id: pending.id, code }),
      "rl-btn rl-btn--primary rl-btn--sm",
    );
    approve.disabled = true;
    requestGroupElement.append(
      el(
        "div",
        "rl-code-row",
        el(
          "div",
          "",
          el("span", "rl-caption", "Verification code"),
          el("span", "rl-code rl-code--md", groupedCode(code)),
        ),
        el(
          "p",
          "rl-text",
          "Compare this code with the one on the new device. Never approve a request you didn’t start.",
        ),
      ),
      el(
        "div",
        "rl-row",
        el(
          "div",
          "rl-row-copy",
          checkbox("I started this request and the codes match on both devices.", (checked) => {
            approve.disabled = !checked;
          }),
        ),
        el(
          "div",
          "rl-row-actions",
          button(
            "Deny",
            () => void act("deny", { id: pending.id }),
            "rl-btn rl-btn--danger rl-btn--sm",
          ),
          approve,
        ),
      ),
    );
  } else
    requestGroupElement.append(
      el(
        "div",
        "rl-row",
        el(
          "div",
          "rl-row-copy",
          el(
            "span",
            "rl-row-desc",
            pending.reviewing
              ? "Waiting for the pairing exchange. Keep both setup pages open."
              : "Verify the other device before allowing access.",
          ),
        ),
        el(
          "div",
          "rl-row-actions",
          ...(!pending.reviewing
            ? [button("Review", () => void act("review", { id: pending.id }), "rl-btn rl-btn--sm")]
            : []),
          button(
            "Deny",
            () => void act("deny", { id: pending.id }),
            "rl-btn rl-btn--danger rl-btn--sm",
          ),
        ),
      ),
    );
  return requestGroupElement;
}

function deviceRow(device: Status["devices"][number]) {
  const isThis = device.id === state.device;
  const online = isThis || !!device.online;
  const meta = `${isThis ? "This device · " : ""}${device.online || isThis ? "Online" : device.lastSeen ? `Last seen ${ago(device.lastSeen).toLowerCase()}` : "Offline"}`;
  if (renaming === device.id) {
    const field = el("input", "rl-input rl-input--sm");
    field.value = renameValue;
    field.setAttribute("aria-label", `New name for ${device.name}`);
    field.maxLength = 64;
    const save = () => {
      const name = field.value.trim();
      if (!name) return;
      renaming = undefined;
      void act("rename", { id: device.id, name });
    };
    const cancel = () => {
      renaming = undefined;
      render();
    };
    field.oninput = () => {
      renameValue = field.value;
    };
    field.onkeydown = (event) => {
      if (event.key === "Enter") save();
      if (event.key === "Escape") cancel();
    };
    queueMicrotask(() => field.focus());
    return el(
      "div",
      "rl-row device-row",
      dot(online),
      el("div", "rl-row-copy", field),
      el(
        "div",
        "rl-row-actions",
        button("Cancel", cancel, "rl-btn rl-btn--ghost rl-btn--sm"),
        button("Save", save, "rl-btn rl-btn--primary rl-btn--sm"),
      ),
    );
  }
  const identity = [
    dot(online),
    el(
      "div",
      "rl-row-copy",
      el("span", "rl-row-title", device.name),
      el("span", "rl-row-desc", meta),
    ),
  ];
  if (revoking === device.id)
    return el(
      "div",
      "rl-row rl-row--confirm device-row",
      el("div", "rl-confirm-head", ...identity),
      el(
        "div",
        "rl-confirm",
        el(
          "p",
          "rl-small",
          `Revoke ${device.name}? Relay rotates the workspace key so it can’t read future changes. Tabs already open on it stay open.`,
        ),
        el(
          "div",
          "rl-row-actions",
          button(
            "Cancel",
            () => {
              revoking = undefined;
              render();
            },
            "rl-btn rl-btn--sm",
          ),
          button(
            "Revoke device",
            () => {
              revoking = undefined;
              void act("revoke", { id: device.id });
            },
            "rl-btn rl-btn--danger-solid rl-btn--sm",
          ),
        ),
      ),
    );
  const actions = el(
    "div",
    "rl-row-actions",
    button(
      "Rename",
      () => {
        renaming = device.id;
        renameValue = device.name;
        revoking = undefined;
        render();
      },
      "rl-btn rl-btn--ghost rl-btn--sm",
    ),
  );
  const renameButton = actions.firstElementChild;
  renameButton?.setAttribute("aria-label", `Rename ${device.name}`);
  if (!isThis)
    actions.append(
      button(
        "Revoke",
        () => {
          revoking = device.id;
          renaming = undefined;
          render();
        },
        "rl-btn rl-btn--ghost rl-btn--danger rl-btn--sm",
      ),
    );
  actions.lastElementChild?.setAttribute(
    "aria-label",
    isThis ? `Rename ${device.name}` : `Revoke ${device.name}`,
  );
  return el("div", "rl-row device-row", ...identity, actions);
}

function devicesPage(column: HTMLElement) {
  column.append(
    pageHeader(
      "Devices",
      "Every device here can read and change your workspace. Device names are end-to-end encrypted.",
    ),
  );
  for (const pending of state.approvals) column.append(requestGroup(pending));
  const ordered = [...state.devices].sort(
    (a, b) => Number(b.id === state.device) - Number(a.id === state.device),
  );
  column.append(
    sectionBlock(
      countLabel(ordered.length, "device"),
      ordered.length ? group(...ordered.map(deviceRow)) : el("p", "rl-note", "No devices yet."),
    ),
  );
}

function securityPage(column: HTMLElement) {
  const accountLine = el(
    "div",
    "rl-row-head rl-row-head--flush",
    el(
      "span",
      "rl-secret account-number",
      revealed ? grouped(state.account ?? "") : masked(state.account ?? ""),
    ),
    el(
      "div",
      "rl-row-actions",
      button(
        revealed ? "Hide" : "Reveal",
        () => {
          revealed = !revealed;
          render();
        },
        "rl-btn rl-btn--sm",
      ),
      button("Copy account number", () => copy(state.account ?? ""), "rl-btn rl-btn--sm"),
    ),
  );
  column.append(
    pageHeader(
      "Security",
      "Your workspace is encrypted on this device before it reaches the Relay server.",
    ),
    sectionBlock(
      "Account number",
      group(
        el(
          "div",
          "rl-group-pad",
          accountLine,
          el(
            "span",
            "rl-small",
            "Enter this on a new device to join. It identifies your account, but it isn’t an encryption key.",
          ),
        ),
      ),
    ),
    sectionBlock(
      "Encryption",
      group(
        valueRow("Workspace contents", "AES-256-GCM, encrypted on this device"),
        row(
          "Workspace key",
          "Revoking a device replaces the key for future changes.",
          el("span", "rl-row-value", `Epoch ${state.epoch ?? "–"}`),
        ),
      ),
    ),
    sectionBlock(
      "Recovery",
      group(
        el(
          "div",
          "rl-group-pad",
          el(
            "p",
            "rl-text",
            "Use the recovery information you saved during setup to authorize a device when none of your others are available. Relay can’t retrieve it for you.",
          ),
          el("p", "rl-small", "Replacing the recovery key isn’t available in this version."),
        ),
      ),
    ),
  );
}

function serverPage(column: HTMLElement) {
  const service = serverPresentation();
  column.append(
    pageHeader(
      "Server",
      "The Relay server orders and relays encrypted changes between your devices.",
    ),
    group(
      row(service.name, service.description, statusBadge(state.status)),
      valueRow("Address", state.server),
    ),
    el(
      "div",
      "rl-facts",
      el(
        "div",
        "",
        el("h3", "", "One server per account"),
        el(
          "p",
          "rl-small",
          "Accounts and their encrypted workspaces belong to the server they were created on. Changing servers isn’t a migration. To use another server, set Relay up in a separate browser profile.",
        ),
      ),
    ),
  );
}

function aboutPage(column: HTMLElement) {
  const source = el("a", "rl-btn rl-btn--sm", "View source on GitHub", icon("external"));
  source.href = __REPOSITORY_URL__;
  source.target = "_blank";
  source.rel = "noreferrer";
  const fact = (title: string, text: string) =>
    el(
      "div",
      "rl-fact-row",
      el("span", "rl-row-title", title),
      el("span", "rl-small rl-fact-text", text),
    );
  column.append(
    pageHeader("About", "Private workspace sync for Helium and compatible Chromium browsers."),
    group(
      el(
        "div",
        "rl-version",
        mark(),
        el(
          "div",
          "rl-summary-copy",
          el("span", "rl-summary-strong about-version", `Relay ${__PRODUCT_VERSION__}`),
          el(
            "span",
            "rl-small",
            `Build ${displayBuildId(__BUILD_ID__)} · Experimental pre-release`,
          ),
        ),
        source,
      ),
    ),
    group(
      fact(
        "Privacy",
        "Your workspace is encrypted on your devices before it reaches Relay. The service can’t read synchronized URLs, tab-group titles, device names, or workspace contents. Page titles aren’t collected.",
      ),
      fact("License", "Open source under AGPL-3.0-or-later."),
      fact("Compatibility", "Built for Helium. Works with compatible Chromium browsers."),
      fact(
        "Disclaimer",
        "Relay is an independent project, not affiliated with or endorsed by Helium.",
      ),
    ),
  );
}

const pages: [name: string, glyph: IconName, render: (column: HTMLElement) => void][] = [
  ["General", "general", generalPage],
  ["Synchronization", "sync", synchronizationPage],
  ["Devices", "devices", devicesPage],
  ["Security", "security", securityPage],
  ["Server", "server", serverPage],
  ["About", "about", aboutPage],
];

function settings() {
  const nav = el("nav", "rl-nav");
  nav.setAttribute("aria-label", "Settings");
  for (const [name, glyph] of pages) {
    const requests = name === "Devices" ? state.approvals.length : 0;
    const item = button(
      [
        icon(glyph),
        el("span", "rl-nav-label", name),
        requests ? el("span", "rl-badge", String(requests)) : "",
      ],
      () => {
        section = name;
        renaming = undefined;
        revoking = undefined;
        render();
      },
      "rl-nav-item",
    );
    if (requests) item.setAttribute("aria-label", `${name}, ${countLabel(requests, "request")}`);
    if (section === name) item.setAttribute("aria-current", "page");
    nav.append(item);
  }
  const live = state.status === "Live" && !state.paused;
  const column = el("div", "rl-column");
  column.dataset.errorTarget = "";
  const page = pages.find(([name]) => name === section) ?? pages[0];
  page?.[2](column);
  return el(
    "div",
    "rl-settings",
    el(
      "aside",
      "rl-sidebar",
      el("div", "rl-sidebar-top", brand(true), nav),
      el(
        "div",
        "rl-sidebar-status",
        statusBadge(state.status),
        el("span", "rl-caption", `· ${syncedLabel(state.lastSynced, live).toLowerCase()}`),
      ),
    ),
    el("div", "rl-content", column),
  );
}

function attentionKey(value: Status) {
  return JSON.stringify([
    value.phase,
    value.account,
    value.device,
    value.server,
    value.error,
    value.pair,
    value.approvals,
    value.status,
    value.paused,
    value.preferences,
  ]);
}

function render() {
  if (!app) return;
  // A join/recovery draft has no newly generated recovery key. Keep it retryable,
  // including after a settings-page reload, instead of offering Start syncing.
  if (state.phase === "draft" && !state.recovery && screen === "welcome") screen = "join";
  const context = JSON.stringify([state.phase, state.account, state.server, screen, section]);
  // Keep an unsent recovery draft through redraws only in the same account and view.
  const recoveryDraft =
    context === lastContext
      ? app.querySelector<HTMLInputElement>(".recovery-field")?.value
      : undefined;
  if (context !== lastContext) revealed = false;
  if (renaming && !state.devices.some((device) => device.id === renaming)) renaming = undefined;
  if (revoking && !state.devices.some((device) => device.id === revoking)) revoking = undefined;
  app.className = "";
  const page = state.phase === "active" ? settings() : onboarding();
  if (state.error) page.querySelector("[data-error-target]")?.prepend(errorMessage(state.error));
  if (context !== lastContext) page.querySelector("[data-error-target]")?.classList.add("rl-enter");
  app.replaceChildren(page);
  const recoveryField = app.querySelector<HTMLInputElement>(".recovery-field");
  if (recoveryField && recoveryDraft !== undefined) recoveryField.value = recoveryDraft;
  lastView = statusViewKey(state);
  lastAttention = attentionKey(state);
  lastContext = context;
}

async function refresh() {
  if (busy || refreshing || document.hidden) return;
  refreshing = true;
  try {
    const next = await call("status", { poll: state?.phase === "pending" });
    if (busy) return;
    const changed = statusViewKey(next) !== lastView;
    const needsAttention = attentionKey(next) !== lastAttention;
    state = next;
    if (changed && (needsAttention || document.activeElement?.tagName !== "INPUT")) render();
  } catch (error) {
    report(error);
  } finally {
    refreshing = false;
  }
}

watchStatus(() => {
  if (state) void refresh();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
window.addEventListener("focus", () => void refresh());
void call("status")
  .then((value) => {
    state = value;
    serverValue = value.server;
    render();
    // Pending requesters have no live socket yet. Active accounts receive events.
    setInterval(() => {
      if (state.phase === "pending") void refresh();
    }, 3000);
  })
  .catch(report);
