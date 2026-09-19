// SPDX-License-Identifier: AGPL-3.0-or-later
declare const __DEV__: boolean;
declare const __DIAGNOSTICS__: boolean;
type Source = "USER" | "REMOTE" | "RECONCILE" | "STARTUP";
type Action = "EMIT" | "APPLY" | "SUPPRESS" | "SKIP_DUPLICATE" | "DETECTED";
export type BrowserRaceReason =
  | "browser_closing"
  | "superseded_plan"
  | "freshness_generation_changed"
  | "local_delete_blocks_mutation"
  | "local_navigation_blocks_remote_navigation"
  | "initial_snapshot_invalid"
  | "destructive_boundary_changed"
  | "group_boundary_changed"
  | "group_members_unavailable"
  | "group_members_changed"
  | "missing_tab"
  | "missing_window"
  | "missing_group"
  | "tab_not_editable"
  | "window_closing"
  | "unknown_browser_runtime_error";
export interface BrowserRaceDiagnostic {
  reason: BrowserRaceReason;
  boundary: string;
  plan?: number;
  capturedFreshness?: number;
  currentFreshness?: number;
  mutation?: "create" | "navigate";
  intentKind?: "delete" | "navigate";
  intentGeneration?: number;
  revision?: number;
  lifecycle?: string;
  persistedIntent?: boolean;
  logicalId?: string;
  browserId?: number;
  browserWindows?: number;
  browserTabs?: number;
  browserGroups?: number;
}
export interface DiagnosticEntry {
  timestamp: number;
  device: string;
  operation: string;
  resource: string;
  source: Source;
  event: string;
  action: Action;
  detail?: string;
  browserRace?: BrowserRaceDiagnostic;
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
  detail?: string,
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
    detail,
  });
  if (entries.length > 200) entries.shift();
}
export function browserRace(diagnostic: BrowserRaceDiagnostic) {
  if (!enabled()) return;
  const safe: BrowserRaceDiagnostic = {
    reason: diagnostic.reason,
    boundary: diagnostic.boundary,
    ...(diagnostic.plan === undefined ? {} : { plan: diagnostic.plan }),
    ...(diagnostic.capturedFreshness === undefined
      ? {}
      : { capturedFreshness: diagnostic.capturedFreshness }),
    ...(diagnostic.currentFreshness === undefined
      ? {}
      : { currentFreshness: diagnostic.currentFreshness }),
    ...(diagnostic.mutation === undefined ? {} : { mutation: diagnostic.mutation }),
    ...(diagnostic.intentKind === undefined ? {} : { intentKind: diagnostic.intentKind }),
    ...(diagnostic.intentGeneration === undefined
      ? {}
      : { intentGeneration: diagnostic.intentGeneration }),
    ...(diagnostic.revision === undefined ? {} : { revision: diagnostic.revision }),
    ...(diagnostic.lifecycle === undefined ? {} : { lifecycle: diagnostic.lifecycle }),
    ...(diagnostic.persistedIntent === undefined
      ? {}
      : { persistedIntent: diagnostic.persistedIntent }),
    ...(diagnostic.logicalId === undefined ? {} : { logicalId: diagnostic.logicalId.slice(-6) }),
    ...(diagnostic.browserId === undefined ? {} : { browserId: diagnostic.browserId }),
    ...(diagnostic.browserWindows === undefined
      ? {}
      : { browserWindows: diagnostic.browserWindows }),
    ...(diagnostic.browserTabs === undefined ? {} : { browserTabs: diagnostic.browserTabs }),
    ...(diagnostic.browserGroups === undefined ? {} : { browserGroups: diagnostic.browserGroups }),
  };
  entries.push({
    timestamp: Date.now(),
    device,
    resource: safe.logicalId ?? "",
    operation: "",
    source: "RECONCILE",
    event: "BROWSER_RACE",
    action: "DETECTED",
    browserRace: safe,
  });
  if (entries.length > 200) entries.shift();
}
export function diagnosticSnapshot() {
  return enabled() ? { counters: { ...counters }, entries: [...entries] } : undefined;
}
