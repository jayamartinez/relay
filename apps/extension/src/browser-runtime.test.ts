import { expect, it } from "vitest";
import { asBrowserRuntimeRace, browserRuntimeRaceReason } from "./browser-runtime";

it.each([
  ["No tab with id: 3.", "missing_tab"],
  ["No window with id: 4.", "missing_window"],
  ["No group with id: 5.", "missing_group"],
  ["Tabs cannot be edited right now (user may be dragging a tab).", "tab_not_editable"],
  ["The window was closed.", "window_closing"],
])("categorizes Chromium runtime races", (message, reason) => {
  expect(browserRuntimeRaceReason(message)).toBe(reason);
});

it("retains the safe numeric browser ID from a Chromium race", () => {
  expect(asBrowserRuntimeRace(new Error("No tab with id: 42."))).toMatchObject({
    reason: "missing_tab",
    browserId: 42,
  });
});
