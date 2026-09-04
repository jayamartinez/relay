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
  const img = el("img");
  img.src = "mark.svg";
  img.alt = "";
  return el("div", "brand", img, "Relay");
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
export function ago(timestamp: number | undefined) {
  if (!timestamp) return "Not yet";
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} hr ago` : `${Math.floor(hours / 24)} days ago`;
}
