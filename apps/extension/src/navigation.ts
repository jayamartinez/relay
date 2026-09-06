// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LogicalTab } from "@relay/protocol";
import { syncableTab } from "@relay/shared";
import { type Mapping, navigationKey } from "./browser-model";
import { trace } from "./diagnostics";
export const REMOTE_NAVIGATION_TTL = 15_000;
export function committedNavigation(
  mapping: Mapping,
  local: number,
  url: string,
  transition: string,
  qualifiers: string[],
  now = Date.now(),
) {
  const logical = mapping.tabs[local];
  const receipt = logical ? mapping.navigation?.[logical] : undefined;
  if (!receipt || receipt.local !== local || receipt.expires <= now) {
    trace("USER", "COMMIT_UNOWNED", "DETECTED", logical);
    return false;
  }
  const classified = syncableTab(url);
  const key = classified ? navigationKey(classified) : url;
  const user =
    qualifiers.includes("from_address_bar") ||
    qualifiers.includes("forward_back") ||
    ["typed", "generated", "keyword", "keyword_generated", "auto_bookmark"].includes(transition);
  if (user && key !== receipt.expectedUrl) {
    receipt.expires = 0;
    mapping.expected = mapping.expected.filter(
      (event) =>
        event.resource !== logical || !["tab-create", "tab-navigate"].includes(event.mutation),
    );
    if (mapping.reversals) delete mapping.reversals[logical!];
    return false;
  }
  if (qualifiers.some((q) => q === "server_redirect" || q === "client_redirect")) {
    receipt.redirects = [...new Set([...(receipt.redirects ?? []), key])].slice(-8);
    trace(receipt.source ?? "REMOTE", "REDIRECT", "SUPPRESS", logical, receipt.operationId);
    return true;
  }
  return false;
}
export function expectNavigation(
  mapping: Mapping,
  tab: LogicalTab,
  local: number,
  previous: string | undefined,
  operationId: string,
  source: "USER" | "REMOTE" = "REMOTE",
) {
  mapping.navigation ??= {};
  mapping.navigation[tab.id] = {
    local,
    resource: tab.id,
    operationId,
    expectedUrl: navigationKey(tab),
    previousUrl: previous,
    expires: Date.now() + REMOTE_NAVIGATION_TTL,
    source,
  };
}
export function remoteNavigationEvent(
  mapping: Mapping,
  local: number,
  url: string,
  complete: boolean,
  now = Date.now(),
): boolean {
  const logical = mapping.tabs[local];
  const receipt = logical ? mapping.navigation?.[logical] : undefined;
  if (!receipt || receipt.local !== local || receipt.expires <= now) return false;
  const classified = syncableTab(url);
  const key = classified ? navigationKey(classified) : url;
  const owned = receipt.redirects?.includes(key) ?? false;
  const matched = key === receipt.expectedUrl || key === receipt.previousUrl;
  if (!owned && !matched) return false;
  if (complete && !receipt.completeAt) receipt.completeAt = now;
  receipt.settledUrl = key;
  trace(receipt.source ?? "REMOTE", "ON_UPDATED", "SUPPRESS", logical, receipt.operationId);
  return true;
}
export function skipRemoteNavigation(
  mapping: Mapping,
  tab: LogicalTab,
  local: number,
  current: string | undefined,
): boolean {
  const actual = syncableTab(current);
  const key = actual ? navigationKey(actual) : current;
  const desired = navigationKey(tab);
  if (key === desired) {
    trace("RECONCILE", "TAB_NAVIGATE", "SKIP_DUPLICATE", tab.id);
    return true;
  }
  const receipt = mapping.navigation?.[tab.id];
  // An owned redirect is a local consequence, not a reason to reload the original URL
  // on every canonical pull. A new canonical destination still applies normally.
  if (
    receipt?.local === local &&
    receipt.expectedUrl === desired &&
    ((receipt.expires > Date.now() && !receipt.completeAt) || receipt.settledUrl === key)
  ) {
    trace("RECONCILE", "TAB_NAVIGATE", "SKIP_DUPLICATE", tab.id, receipt.operationId);
    return true;
  }
  return false;
}
