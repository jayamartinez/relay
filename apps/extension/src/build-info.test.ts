// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { displayBuildId, formatRelayBuild, UNKNOWN_BUILD_ID } from "./build-info";

it("formats the installed Relay 0.1.0 build identifier", () => {
  expect(formatRelayBuild("0.1.0", "abc1234")).toBe("Relay 0.1.0 (abc1234)");
});

it("uses a safe visible fallback when build metadata is missing", () => {
  expect(displayBuildId(undefined)).toBe(UNKNOWN_BUILD_ID);
  expect(displayBuildId(" ")).toBe(UNKNOWN_BUILD_ID);
  expect(formatRelayBuild("0.1.0", null)).toBe("Relay 0.1.0 (unknown)");
});

it("displays a dirty build identifier without altering it", () => {
  expect(formatRelayBuild("0.1.0", "abc1234-dirty")).toBe("Relay 0.1.0 (abc1234-dirty)");
});
