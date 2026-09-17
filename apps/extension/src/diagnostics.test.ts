import { afterEach, expect, it, vi } from "vitest";
import { browserRace, diagnosticSnapshot } from "./diagnostics";

afterEach(() => vi.unstubAllGlobals());

it("keeps reconciliation race diagnostics development-only", () => {
  vi.stubGlobal("__DEV__", false);
  vi.stubGlobal("__DIAGNOSTICS__", false);
  browserRace({ reason: "missing_tab", boundary: "chromium_api", logicalId: "logical-secret" });
  expect(diagnosticSnapshot()).toBeUndefined();
});

it("redacts logical IDs, excludes unknown fields, and bounds the race buffer", () => {
  vi.stubGlobal("__DEV__", true);
  vi.stubGlobal("__DIAGNOSTICS__", true);
  for (let index = 0; index < 205; index++)
    browserRace({
      reason: "freshness_generation_changed",
      boundary: "mutation_boundary",
      logicalId: `logical-id-${index}`,
      plan: index,
      ...({ url: "https://private.example/", title: "private title" } as object),
    } as Parameters<typeof browserRace>[0]);
  const snapshot = diagnosticSnapshot();
  const entries = snapshot?.entries.filter((entry) => entry.event === "BROWSER_RACE") ?? [];
  expect(entries).toHaveLength(200);
  expect(entries[0]?.browserRace).toMatchObject({
    reason: "freshness_generation_changed",
    logicalId: "l-id-5",
    plan: 5,
  });
  expect(JSON.stringify(entries)).not.toContain("private.example");
  expect(JSON.stringify(entries)).not.toContain("private title");
});
