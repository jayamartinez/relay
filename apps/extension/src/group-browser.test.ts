import { emptyWorkspace } from "@relay/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { groupsAvailable, requireGroupSupport } from "./group-browser";

afterEach(() => vi.unstubAllGlobals());
it("keeps group workspaces fail-closed when browser capability is absent", () => {
  vi.stubGlobal("__DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__", false);
  const legacy = emptyWorkspace();
  expect(() => requireGroupSupport(legacy)).not.toThrow();
  const grouped = { ...legacy, version: 2 as const };
  const before = structuredClone(grouped);
  expect(() => requireGroupSupport(grouped)).toThrow("unavailable in this browser");
  expect(grouped).toEqual(before);
});
it("does not attempt group sync when a browser lacks supported APIs", () => {
  vi.stubGlobal("__DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__", false);
  vi.stubGlobal("chrome", { tabs: {} });
  expect(groupsAvailable()).toBe(false);
  expect(() => requireGroupSupport({ ...emptyWorkspace(), version: 2 })).toThrow();
});
