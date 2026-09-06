// SPDX-License-Identifier: AGPL-3.0-or-later

export const UNKNOWN_BUILD_ID = "unknown";

export function displayBuildId(buildId: string | undefined | null) {
  const value = buildId?.trim();
  return value || UNKNOWN_BUILD_ID;
}

export function formatRelayBuild(version: string, buildId: string | undefined | null) {
  return `Relay ${version} (${displayBuildId(buildId)})`;
}
