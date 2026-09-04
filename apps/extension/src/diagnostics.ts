// SPDX-License-Identifier: AGPL-3.0-or-later
declare const __DEV__: boolean;
declare const __DIAGNOSTICS__: boolean;
type Source = "USER" | "REMOTE" | "RECONCILE" | "STARTUP";
type Action = "EMIT" | "APPLY" | "SUPPRESS" | "SKIP_DUPLICATE" | "DETECTED";
export interface DiagnosticEntry {
  timestamp: number;
  device: string;
  operation: string;
  resource: string;
  source: Source;
  event: string;
  action: Action;
}
const counters: Record<string, number> = {};
const entries: DiagnosticEntry[] = [];
let device = "";
const enabled = () =>
  typeof __DEV__ !== "undefined" &&
  __DEV__ &&
  typeof __DIAGNOSTICS__ !== "undefined" &&
  __DIAGNOSTICS__;
export function diagnosticDevice(id: string) {
  device = id.slice(-6);
}
export function trace(
  source: Source,
  event: string,
  action: Action,
  resource = "",
  operation = "",
) {
  if (!enabled()) return;
  const key = `${event}.${action}`;
  counters[key] = (counters[key] ?? 0) + 1;
  entries.push({
    timestamp: Date.now(),
    device,
    resource: resource.slice(-6),
    operation: operation.slice(-6),
    source,
    event,
    action,
  });
  if (entries.length > 200) entries.shift();
}
export function diagnosticSnapshot() {
  return enabled() ? { counters: { ...counters }, entries: [...entries] } : undefined;
}
