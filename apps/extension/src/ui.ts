// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Controller, Status } from "./controller";

type Child = Node | string | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  for (const child of children) if (child !== undefined && child !== false) element.append(child);
  return element;
}

export function button(
  label: string | Node | (string | Node)[],
  action: () => void,
  className = "rl-btn",
) {
  const b = el("button", className, ...(Array.isArray(label) ? label : [label]));
  b.type = "button";
  b.onclick = action;
  return b;
}

// Icons are built with DOM APIs: extension pages enforce Trusted Types, so markup
// strings cannot be assigned to innerHTML.
const SVG = "http://www.w3.org/2000/svg";
type Shape = [tag: "path" | "rect" | "circle", attributes: Record<string, string>];
const stroke = { fill: "none", stroke: "currentColor", "stroke-width": "1.4" };
const round = { "stroke-linecap": "round", "stroke-linejoin": "round" };
const icons: Record<string, Shape[]> = {
  lock: [
    [
      "rect",
      { x: "3", y: "7", width: "10", height: "7", rx: "1.5", ...stroke, "stroke-width": "1.5" },
    ],
    ["path", { d: "M5.5 7V5a2.5 2.5 0 0 1 5 0v2", ...stroke, "stroke-width": "1.5" }],
  ],
  pause: [["path", { d: "M5.5 3.5v9M10.5 3.5v9", ...stroke, "stroke-width": "1.6", ...round }]],
  play: [["path", { d: "M4.5 3v10l8-5z", fill: "currentColor" }]],
  external: [
    ["path", { d: "M6 3.5h6.5V10M12.2 3.8 4 12", ...stroke, "stroke-width": "1.5", ...round }],
  ],
  chevron: [["path", { d: "m4 6 4 4 4-4", ...stroke, "stroke-width": "1.6", ...round }]],
  back: [
    ["path", { d: "M13 8H3.5M7.5 3.5 3 8l4.5 4.5", ...stroke, "stroke-width": "1.5", ...round }],
  ],
  next: [
    ["path", { d: "M3 8h9.5M8.5 3.5 13 8l-4.5 4.5", ...stroke, "stroke-width": "1.5", ...round }],
  ],
  check: [
    ["path", { d: "M3.5 8.4 6.6 11.3 12.5 4.8", ...stroke, "stroke-width": "1.9", ...round }],
  ],
  cross: [
    ["path", { d: "M4.5 4.5l7 7M11.5 4.5l-7 7", ...stroke, "stroke-width": "1.7", ...round }],
  ],
  download: [
    ["path", { d: "M8 2.5v7M5 7l3 3 3-3M3 13.5h10", ...stroke, "stroke-width": "1.5", ...round }],
  ],
  window: [
    ["rect", { x: "1.5", y: "3", width: "13", height: "10", rx: "2", ...stroke }],
    ["path", { d: "M1.5 6h13", ...stroke }],
  ],
  general: [
    [
      "path",
      {
        d: "M2.5 7.3 8 2.8l5.5 4.5v5.6a.6.6 0 0 1-.6.6H10V9.8H6v3.7H3.1a.6.6 0 0 1-.6-.6z",
        ...stroke,
        "stroke-linejoin": "round",
      },
    ],
  ],
  sync: [
    [
      "path",
      {
        d: "M13.2 6.6A5.3 5.3 0 0 0 3.6 4.6M2.8 9.4a5.3 5.3 0 0 0 9.6 2",
        ...stroke,
        "stroke-linecap": "round",
      },
    ],
    ["path", { d: "M3.4 2.2v2.6H6M12.6 13.8v-2.6H10", ...stroke, ...round }],
  ],
  devices: [
    ["rect", { x: "1.5", y: "3", width: "9", height: "7", rx: "1.2", ...stroke }],
    ["path", { d: "M4 12.8h4", ...stroke, "stroke-linecap": "round" }],
    ["rect", { x: "11.5", y: "5.5", width: "3", height: "7.3", rx: "0.9", ...stroke }],
  ],
  security: [
    [
      "path",
      {
        d: "M8 1.8 13 3.8v3.7c0 3-2.1 5.4-5 6.7-2.9-1.3-5-3.7-5-6.7V3.8z",
        ...stroke,
        "stroke-linejoin": "round",
      },
    ],
  ],
  server: [
    ["rect", { x: "2", y: "2.5", width: "12", height: "4.5", rx: "1.2", ...stroke }],
    ["rect", { x: "2", y: "9", width: "12", height: "4.5", rx: "1.2", ...stroke }],
  ],
  about: [
    ["circle", { cx: "8", cy: "8", r: "6", ...stroke }],
    ["path", { d: "M8 7.2v3.8", ...stroke, "stroke-linecap": "round" }],
    ["circle", { cx: "8", cy: "5", r: "0.9", fill: "currentColor" }],
  ],
};

export type IconName = keyof typeof icons;

export function icon(name: IconName, className = "rl-icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const [tag, attributes] of icons[name] ?? []) {
    const shape = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

/** Relay's mark: two overlapping windows; the shared area is what Relay keeps in sync. */
export function mark(className = "rl-mark") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const tile = document.createElementNS(SVG, "rect");
  for (const [key, value] of Object.entries({
    width: "256",
    height: "256",
    rx: "67",
    fill: "var(--rl-mark)",
  }))
    tile.setAttribute(key, value);
  const glyph = document.createElementNS(SVG, "path");
  glyph.setAttribute("fill", "#FBFCFF");
  glyph.setAttribute("fill-rule", "evenodd");
  glyph.setAttribute(
    "d",
    "M51 80a29 29 0 0 1 29-29h58a29 29 0 0 1 29 29v58a29 29 0 0 1-29 29H80a29 29 0 0 1-29-29zM89 118a29 29 0 0 1 29-29h58a29 29 0 0 1 29 29v58a29 29 0 0 1-29 29h-58a29 29 0 0 1-29-29z",
  );
  svg.append(tile, glyph);
  return svg;
}

export function brand(large = false) {
  return el("span", `rl-wordmark brand${large ? " rl-wordmark--lg" : ""}`, mark(), "Relay");
}

export type StatusTone = "live" | "syncing" | "busy" | "attention" | "offline" | "paused";

export function toneFor(label: string): StatusTone {
  const normalized = label.toLowerCase();
  if (normalized === "paused") return "paused";
  if (/needs attention|waiting/.test(normalized)) return "attention";
  if (/connecting|recovering/.test(normalized)) return "busy";
  if (/syncing/.test(normalized)) return "syncing";
  if (/^live$|online|connected/.test(normalized) && !/not connected/.test(normalized))
    return "live";
  return "offline";
}

export function statusBadge(label: string, tone: StatusTone = toneFor(label)) {
  const badge = el("span", "rl-status", label);
  badge.setAttribute("role", "status");
  badge.dataset.tone = tone;
  return badge;
}

export function switchControl(
  label: string,
  checked: boolean,
  disabled: boolean,
  onChange: (checked: boolean) => void,
) {
  const control = el("input", "rl-switch-input");
  control.type = "checkbox";
  control.checked = checked;
  control.disabled = disabled;
  control.setAttribute("role", "switch");
  control.setAttribute("aria-label", label);
  control.onchange = () => onChange(control.checked);
  return el(
    "label",
    "rl-switch",
    control,
    el("span", "rl-switch-track", el("span", "rl-switch-thumb")),
    el("span", "sr-only", disabled ? `${label}, unavailable` : label),
  );
}

export function input(label: string, value = "", type = "text", className = "rl-input") {
  const field = el("input", className);
  field.type = type;
  field.value = value;
  field.autocomplete = "off";
  field.spellcheck = false;
  const wrapper = el("label", "rl-field", label, field);
  return { field, wrapper };
}

export function alertMessage(text: string, title = "Couldn’t complete that") {
  const message = el("div", "rl-alert", el("span", "rl-alert-title", title), el("p", "", text));
  message.setAttribute("role", "alert");
  return message;
}

type HealthResult = Awaited<ReturnType<Controller["health"]>>;
export function call(action: "health", payload: { server: string }): Promise<HealthResult>;
export function call(action: string, payload?: Record<string, unknown>): Promise<Status>;
export async function call(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<Status | HealthResult> {
  const response = await chrome.runtime.sendMessage({ action, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? "Relay background worker is unavailable.");
  return response.value as Status | HealthResult;
}
export const masked = (account: string) => `•••• •••• •••• •••• •••• ${account.slice(-4)}`;
export const grouped = (account: string) => account.match(/.{4}/g)?.join(" ") ?? account;
export const groupedCode = (code: string) => code.replace(/\s/g, "").replace(/(.{3})(?=.)/, "$1 ");
export const countLabel = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;
export function ago(timestamp: number | undefined) {
  if (!timestamp) return "Not yet";
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}
/** "Synced just now", "Last synced 4 min ago", "Not synced yet". */
export function syncedLabel(timestamp: number | undefined, live: boolean) {
  if (!timestamp) return "Not synced yet";
  const when = ago(timestamp).toLowerCase();
  return live ? `Synced ${when}` : `Last synced ${when}`;
}
