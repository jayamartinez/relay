// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { buildIdentifier } from "./build-metadata.mjs";

function git({ head, status } = {}) {
  return (args) => (args[0] === "rev-parse" ? head : status);
}

it("uses the checkout's short commit SHA for a clean build", () => {
  expect(buildIdentifier({}, git({ head: "abc1234" }))).toBe("abc1234");
});

it("marks a build from a modified checkout as dirty", () => {
  expect(buildIdentifier({}, git({ head: "abc1234", status: " M file.ts" }))).toBe("abc1234-dirty");
});

it("uses unknown when Git metadata is unavailable and never emits an empty identifier", () => {
  expect(buildIdentifier({}, git())).toBe("unknown");
});

it("shortens a supplied full commit SHA", () => {
  expect(buildIdentifier({ RELAY_BUILD_ID: "abcdef0123456789" }, git())).toBe("abcdef0");
});
