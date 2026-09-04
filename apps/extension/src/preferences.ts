// SPDX-License-Identifier: AGPL-3.0-or-later
export interface SyncPreferencesV1 {
  schemaVersion: 1;
  tabCreation: boolean;
  tabClosure: boolean;
  navigation: boolean;
  tabGroups: boolean;
  pinnedTabs: boolean;
  multipleWindows: boolean;
}

export const defaultSyncPreferences = (): SyncPreferencesV1 => ({
  schemaVersion: 1,
  tabCreation: true,
  tabClosure: true,
  navigation: true,
  tabGroups: true,
  pinnedTabs: true,
  multipleWindows: true,
});

export function migrateSyncPreferences(raw: unknown): SyncPreferencesV1 {
  const defaults = defaultSyncPreferences();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaults;
  const value = raw as Record<string, unknown>;
  // V1 is deliberately additive: malformed/missing values never erase valid choices.
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      key === "schemaVersion" ? 1 : typeof value[key] === "boolean" ? value[key] : fallback,
    ]),
  ) as SyncPreferencesV1;
}

const KEY = "relay-sync-preferences";
export async function loadSyncPreferences(): Promise<SyncPreferencesV1> {
  const stored = await chrome.storage.local.get(KEY);
  const preferences = migrateSyncPreferences(stored[KEY]);
  if (JSON.stringify(stored[KEY]) !== JSON.stringify(preferences))
    await chrome.storage.local.set({ [KEY]: preferences });
  return preferences;
}

export async function saveSyncPreferences(
  update: Partial<Omit<SyncPreferencesV1, "schemaVersion">>,
): Promise<SyncPreferencesV1> {
  const current = await loadSyncPreferences();
  const next = migrateSyncPreferences({ ...current, ...update });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
