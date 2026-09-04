// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { defaultSyncPreferences, migrateSyncPreferences } from "./preferences";

describe("sync preferences", () => {
  it("defaults to full workspace synchronization", () => {
    expect(defaultSyncPreferences()).toEqual({
      schemaVersion: 1,
      tabCreation: true,
      tabClosure: true,
      navigation: true,
      tabGroups: true,
      pinnedTabs: true,
      multipleWindows: true,
    });
  });
  it("migrates incomplete storage without losing valid choices", () => {
    expect(
      migrateSyncPreferences({ navigation: false, tabGroups: false, pinnedTabs: "no" }),
    ).toMatchObject({
      navigation: false,
      tabGroups: false,
      pinnedTabs: true,
      tabCreation: true,
    });
  });
});
