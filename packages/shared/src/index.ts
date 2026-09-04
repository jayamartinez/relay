// SPDX-License-Identifier: AGPL-3.0-or-later
export const VERSION = 1 as const;
export const LIMITS = {
  devices: 16,
  pending: 8,
  operations: 512,
  message: 2_000_000,
  tabs: 2000,
  windows: 100,
  queue: 2000,
  control: 1000,
};
export function assert(condition: unknown, message = "Invalid protocol data"): asserts condition {
  if (!condition) throw new Error(message);
}
export function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 256): string {
  assert(typeof value === "string" && value.length > 0 && value.length <= max);
  return value;
}
export function integer(value: unknown, min = 0): number {
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= min);
  return value;
}
export function id(value: unknown): string {
  const result = text(value, 64);
  assert(/^[a-zA-Z0-9_-]+$/.test(result));
  assert(!["__proto__", "constructor", "prototype"].includes(result));
  return result;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  assert(value !== undefined && (typeof value !== "number" || Number.isFinite(value)));
  return JSON.stringify(value);
}
export function canonicalAccount(value: string): string {
  const result = value.replace(/\s/g, "");
  assert(/^\d{24}$/.test(result), "Enter a 24-digit account number.");
  return result;
}
export function displayAccount(value: string): string {
  return canonicalAccount(value).match(/.{4}/g)?.join(" ") ?? value;
}
export function serverOrigin(value: string, development: boolean): string {
  const url = new URL(value);
  assert(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      !url.hostname.includes("*"),
    "Enter a server origin without a path.",
  );
  const octets = url.hostname.split(".").map(Number);
  const [first = -1, second = -1] = octets;
  const privateLan =
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168));
  assert(
    url.protocol === "https:" ||
      (development &&
        url.protocol === "http:" &&
        (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || privateLan)),
    "Use HTTPS. HTTP is allowed only for localhost or a private LAN address in development.",
  );
  return url.origin;
}
export type TabKind =
  | "web"
  | "remote-pdf-as-web"
  | "newtab"
  | "local-file"
  | "browser-internal"
  | "extension-page"
  | "devtools"
  | "blob"
  | "data"
  | "other-protected";
export type Classification = { kind: TabKind; url?: string };
export function classifyTab(
  raw: string | undefined,
  incognito = false,
  ownOrigin = "",
): Classification | null {
  if (incognito || (ownOrigin && raw?.startsWith(`${ownOrigin}/`))) return null;
  if (
    !raw ||
    raw === "about:blank" ||
    /^(chrome|helium|edge|brave):\/\/(newtab|new-tab-page)\/?$/.test(raw)
  )
    return { kind: "newtab" };
  try {
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol))
      return { kind: /\.pdf$/i.test(url.pathname) ? "remote-pdf-as-web" : "web", url: url.href };
    const kinds: Record<string, TabKind> = {
      "file:": "local-file",
      "chrome:": "browser-internal",
      "helium:": "browser-internal",
      "edge:": "browser-internal",
      "brave:": "browser-internal",
      "chrome-extension:": "extension-page",
      "devtools:": "devtools",
      "data:": "data",
      "blob:": "blob",
    };
    return { kind: kinds[url.protocol] ?? "other-protected" };
  } catch {
    return { kind: "other-protected" };
  }
}
export const isWeb = (kind: TabKind) => kind === "web" || kind === "remote-pdf-as-web";
export const isSyncable = (kind: TabKind) => isWeb(kind) || kind === "newtab";
export function syncableTab(
  raw: string | undefined,
  incognito = false,
  ownOrigin = "",
): Classification | null {
  if (!raw) return null; // Incomplete startup/create events are not committed new-tab resources.
  const tab = classifyTab(raw, incognito, ownOrigin);
  return tab && isSyncable(tab.kind) ? tab : null;
}
