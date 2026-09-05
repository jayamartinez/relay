// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Controller, Status } from "./controller";
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  for (const child of children) if (child !== undefined) element.append(child);
  return element;
}
export function button(label: string, action: () => void, className = "") {
  const b = el("button", className, label);
  b.type = "button";
  b.onclick = action;
  return b;
}
export function brand() {
  return el("div", "brand", el("span", "brand-word", "Relay"));
}
export function statusBadge(label: string) {
  const badge = el("div", "status", label);
  badge.setAttribute("role", "status");
  const normalized = label.toLowerCase();
  badge.dataset.tone = /not connected|offline|disconnected/.test(normalized)
    ? "neutral"
    : /pause|waiting|connecting/.test(normalized)
      ? "warning"
      : /live|online|connected/.test(normalized)
        ? "success"
        : "neutral";
  return badge;
}
export function switchControl(
  label: string,
  checked: boolean,
  disabled: boolean,
  onChange: (checked: boolean) => void,
) {
  const control = el("input", "switch-input");
  control.type = "checkbox";
  control.checked = checked;
  control.disabled = disabled;
  control.setAttribute("role", "switch");
  control.setAttribute("aria-label", label);
  control.onchange = () => onChange(control.checked);
  return el(
    "label",
    "switch",
    control,
    el("span", "switch-track", el("span", "switch-thumb")),
    el("span", "sr-only", disabled ? `${label}, unavailable` : label),
  );
}
export function input(label: string, value = "", type = "text") {
  const field = el("input");
  field.type = type;
  field.value = value;
  field.autocomplete = "off";
  field.spellcheck = false;
  const wrapper = el("label", "", label, field);
  return { field, wrapper };
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
export function ago(timestamp: number | undefined) {
  if (!timestamp) return "Not yet";
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}
