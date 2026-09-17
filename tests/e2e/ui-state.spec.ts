// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import type { Status } from "../../apps/extension/src/controller";
import { defaultSyncPreferences } from "../../apps/extension/src/preferences";

interface UiHarness {
  state: Status;
  messages: Record<string, unknown>[];
  failures: Record<string, string>;
  hold?: string;
  release?: () => void;
  permissionHold: boolean;
  permissionCalls: number;
  releasePermission?: () => void;
  optionsOpened: number;
  listeners: ((message: { type: string }) => void)[];
}
declare global {
  interface Window {
    relayUiTest: UiHarness;
  }
}

const status = (overrides: Partial<Status> = {}): Status => ({
  phase: "active",
  status: "Live",
  error: "",
  server: "https://relay.example.test",
  official: "",
  channel: "production",
  groups: "Tab groups available",
  capabilities: { tabGroups: true },
  preferences: defaultSyncPreferences(),
  development: false,
  account: "123456789012345678901234",
  device: "synthetic-device",
  name: "Test device",
  paused: false,
  recovery: undefined,
  stats: { windows: 1, tabs: 1, local: 0 },
  workspace: { windows: 1, tabs: 1 },
  epoch: 1,
  revision: 1,
  queue: 0,
  lastSynced: undefined,
  pair: undefined,
  approvals: [],
  approvalActivity: undefined,
  devices: [],
  diagnostics: undefined,
  lifecycle: "LIVE",
  runtime: undefined,
  behavior: undefined,
  startTrace: undefined,
  ...overrides,
});

const bundles: Record<string, string> = {};
test.beforeAll(async () => {
  for (const entry of ["settings", "popup"]) {
    const result = await build({
      entryPoints: ["apps/extension/src/" + entry + ".ts"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: {
        __DEV__: "false",
        __PRODUCT_VERSION__: '"test"',
        __BUILD_ID__: '"test"',
        __REPOSITORY_URL__: '"https://example.test/relay"',
      },
    });
    bundles[entry] = result.outputFiles[0]!.text;
  }
});

async function mount(
  page: Page,
  entry: "settings" | "popup",
  state: Status,
  failures: Record<string, string> = {},
) {
  // Only the DOM and UI entry points run. No extension profile, server or real data is used.
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<main id="app"></main>');
  await page.evaluate(
    ({ state, failures }) => {
      const harness: UiHarness = {
        state,
        messages: [],
        failures,
        permissionHold: false,
        permissionCalls: 0,
        optionsOpened: 0,
        listeners: [],
      };
      window.relayUiTest = harness;
      Object.defineProperty(window, "chrome", {
        configurable: true,
        value: {
          runtime: {
            connect: () => ({
              onMessage: {
                addListener: (listener: (message: { type: string }) => void) =>
                  harness.listeners.push(listener),
              },
              onDisconnect: { addListener: () => {} },
              disconnect: () => {},
            }),
            openOptionsPage: async () => {
              harness.optionsOpened++;
            },
            sendMessage: async (message: Record<string, unknown>) => {
              harness.messages.push(message);
              const action = String(message.action);
              if (harness.hold === action)
                await new Promise<void>((resolve) => {
                  harness.release = resolve;
                });
              const error = harness.failures[action];
              if (error) return { ok: false, error };
              if (action === "preferences")
                Object.assign(harness.state.preferences, message.preferences);
              if (action === "dismiss-approval-result") harness.state.approvalActivity = undefined;
              if (action === "pause") harness.state.paused = !!message.value;
              return { ok: true, value: structuredClone(harness.state) };
            },
          },
          permissions: {
            request: async () => {
              harness.permissionCalls++;
              if (harness.permissionHold)
                await new Promise<void>((resolve) => {
                  harness.releasePermission = resolve;
                });
              return true;
            },
          },
        },
      });
    },
    { state, failures },
  );
  await page.addScriptTag({ content: bundles[entry] });
}

async function pushStatus(page: Page, update: Partial<Status>) {
  await page.evaluate((update) => {
    Object.assign(window.relayUiTest.state, update);
    for (const listener of window.relayUiTest.listeners) listener({ type: "status-changed" });
  }, update);
}

test("retains a recovery draft when a routine status update redraws the form", async ({ page }) => {
  await mount(page, "settings", status({ phase: "welcome", account: undefined }));
  await page.getByRole("button", { name: "Enter account number", exact: true }).click();
  await page.getByRole("button", { name: "Use recovery key", exact: true }).click();
  await page.getByLabel("Recovery key", { exact: true }).fill("synthetic recovery text");
  await page.getByRole("heading", { name: "Use your recovery key" }).click();
  await pushStatus(page, { queue: 1 });
  await expect(page.getByLabel("Recovery key", { exact: true })).toHaveValue(
    "synthetic recovery text",
  );
});

test("requires a fresh confirmation when the displayed pairing code changes", async ({ page }) => {
  const expires = Date.now() + 60_000;
  await mount(
    page,
    "settings",
    status({ phase: "pending", pair: { status: "approved", sas: "123456", expires } }),
  );
  await page.getByRole("checkbox").check();
  await pushStatus(page, { pair: { status: "approved", sas: "654321", expires } });
  await expect(page.getByText("654 321", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish authorization" })).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Finish authorization" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.relayUiTest.messages.find((message) => message.action === "finish-pair")?.code,
      ),
    )
    .toBe("654321");
});

test("removes an expired pairing confirmation while its checkbox has focus", async ({ page }) => {
  await mount(
    page,
    "settings",
    status({
      phase: "pending",
      pair: { status: "approved", sas: "123456", expires: Date.now() + 60_000 },
    }),
  );
  await page.getByRole("checkbox").check();
  await pushStatus(page, { pair: { status: "expired", sas: undefined, expires: Date.now() - 1 } });
  await expect(
    page.getByText("This approval request expired. Cancel and start again."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish authorization" })).toHaveCount(0);
});

test("locks preference controls through a save and preserves unavailable controls", async ({
  page,
}) => {
  await mount(page, "settings", status());
  await page.getByRole("button", { name: "Synchronization", exact: true }).click();
  await page.evaluate(() => {
    window.relayUiTest.hold = "preferences";
  });
  await page.getByRole("switch", { name: "New tabs", exact: true }).uncheck();
  await expect(page.getByRole("switch", { name: "Navigation", exact: true })).toBeDisabled();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => {
    window.relayUiTest.release?.();
  });
  await expect(page.getByRole("switch", { name: "Navigation", exact: true })).toBeEnabled();
  await expect(page.getByRole("switch", { name: "New tabs", exact: true })).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Close tabs", exact: true })).toBeDisabled();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "false");
});

test("locks setup before the host permission request resolves", async ({ page }) => {
  await mount(page, "settings", status({ phase: "welcome", account: undefined }));
  await page.evaluate(() => {
    window.relayUiTest.permissionHold = true;
  });
  await page.getByRole("button", { name: "Create Relay account", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create Relay account", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Enter account number", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    window.relayUiTest.releasePermission?.();
  });
  await expect(
    page.getByRole("button", { name: "Create Relay account", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => window.relayUiTest.permissionCalls)).toBe(1);
});

test("keeps popup settings reachable when sync reports an error", async ({ page }) => {
  await mount(page, "popup", status({ error: "Reconnect required." }));
  await expect(page.getByRole("alert")).toContainText("Reconnect required.");
  await page.getByRole("button", { name: /Settings/ }).click();
  expect(await page.evaluate(() => window.relayUiTest.optionsOpened)).toBe(1);
});

test("does not refresh or review paused requests until the user resumes", async ({ page }) => {
  await mount(
    page,
    "popup",
    status({
      paused: true,
      status: "Paused",
      approvals: [
        {
          id: "paused-request",
          expires: Date.now() + 60_000,
          requestedAt: Date.now(),
          sas: undefined,
          reviewing: false,
          ours: false,
        },
      ],
    }),
  );
  await expect(
    page.getByText("Relay is paused. Resume to review this device request."),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.relayUiTest.messages.map((message) => message.action)),
  ).toEqual(["status"]);
  await page.getByRole("button", { name: "Resume Relay", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.relayUiTest.messages.some((message) => message.action === "review"),
      ),
    )
    .toBe(true);
});

test("keeps the last confirmed preference when saving and status both fail", async ({ page }) => {
  await mount(page, "settings", status());
  await page.getByRole("button", { name: "Synchronization", exact: true }).click();
  await page.evaluate(() => {
    window.relayUiTest.failures = {
      preferences: "Could not save preference.",
      status: "Background unavailable.",
    };
  });
  await page.getByRole("switch", { name: "New tabs", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save preference.");
  await expect(page.getByRole("switch", { name: "New tabs", exact: true })).toBeChecked();
  await expect(page.getByRole("switch", { name: "New tabs", exact: true })).toBeEnabled();
});

test("stops automatic dismissal after a failed request", async ({ page }) => {
  await page.clock.install();
  await mount(
    page,
    "popup",
    status({
      approvalActivity: {
        requestId: "finished-request",
        deviceId: "other-device",
        action: "deny",
        status: "denied",
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
        connected: false,
      },
    }),
    { "dismiss-approval-result": "Background unavailable." },
  );
  await page.clock.runFor(2500);
  await expect(page.getByRole("alert")).toContainText("Background unavailable.");
  await page.clock.runFor(5000);
  expect(
    await page.evaluate(
      () =>
        window.relayUiTest.messages.filter(
          (message) => message.action === "dismiss-approval-result",
        ).length,
    ),
  ).toBe(1);
});

test("retains a popup action error when status refresh has no approval activity", async ({
  page,
}) => {
  await mount(
    page,
    "popup",
    status({
      approvals: [
        {
          id: "synthetic-request",
          expires: Date.now() + 60_000,
          requestedAt: Date.now(),
          sas: "123456",
          reviewing: true,
          ours: true,
        },
      ],
    }),
    { approve: "Request is no longer available." },
  );
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Request is no longer available.");
});

test("provides a retry when the popup cannot read its initial status", async ({ page }) => {
  await mount(page, "popup", status(), { status: "Background unavailable." });
  await expect(page.getByRole("alert")).toContainText("Background unavailable.");
  await page.evaluate(() => {
    window.relayUiTest.failures = {};
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("Main workspace", { exact: true })).toBeVisible();
});

test("lets the user leave a failed result whose request no longer exists", async ({ page }) => {
  await mount(
    page,
    "popup",
    status({
      approvalActivity: {
        requestId: "expired-request",
        deviceId: "other-device",
        action: "approve",
        status: "failed",
        startedAt: Date.now() - 1000,
        finishedAt: Date.now(),
        error: "Request no longer exists.",
        connected: false,
      },
    }),
  );
  await expect(page.getByRole("alert")).toContainText("Request no longer exists.");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByText("Main workspace", { exact: true })).toBeVisible();
});
