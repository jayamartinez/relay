import path from "node:path";
import { chromium, expect, type Page } from "@playwright/test";
import type { Status } from "../apps/extension/src/controller";

export async function profile(directory = "") {
  const extension = path.resolve("apps/extension/dist");
  const context = await chromium.launchPersistentContext(directory, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/settings.html`);
  return { context, page, worker };
}
export async function command(
  page: Page,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<Status> {
  const response = await page.evaluate(
    async ({ action, payload }) => chrome.runtime.sendMessage({ action, ...payload }),
    { action, payload },
  );
  if (!response.ok) throw new Error(response.error);
  return response.value;
}
export const status = (page: Page) => command(page, "status");
export const tabs = (page: Page) => page.evaluate(() => chrome.tabs.query({}));
export const windows = (page: Page) =>
  page.evaluate(() => chrome.windows.getAll({ windowTypes: ["normal"] }));
export const counter = async (page: Page, name: string) =>
  (await status(page)).behavior?.counters[name] ?? 0;
export async function enroll(a: Page, b: Page) {
  await a.getByRole("button", { name: "Create Relay account", exact: true }).click();
  await expect(a.getByRole("heading", { name: "Your Relay account", exact: true })).toBeVisible();
  const account = (await status(a)).account!;
  await a.getByRole("checkbox").check();
  await a.getByRole("button", { name: "Start syncing", exact: true }).click();
  await expect.poll(async () => (await status(a)).phase).toBe("active");
  await b.getByRole("button", { name: "Enter account number", exact: true }).click();
  await b.getByLabel("24-digit account number").fill(account);
  await b.getByRole("button", { name: "Request approval", exact: true }).click();
  await expect.poll(async () => (await status(a)).approvals.length).toBe(1);
  const request = (await status(a)).approvals[0]!;
  await command(a, "review", { id: request.id });
  await expect
    .poll(async () => {
      await command(b, "status", { poll: true });
      return (await status(a)).approvals[0]?.sas;
    })
    .toBeTruthy();
  const code = (await status(a)).approvals[0]!.sas!;
  await command(b, "status", { poll: true });
  expect((await status(b)).pair?.sas).toBe(code);
  await command(a, "approve", { id: request.id, code });
  await command(b, "finish-pair", { code });
  await command(b, "merge");
  await settle(b);
}
export async function settle(page: Page) {
  await expect
    .poll(
      async () => {
        const s = await status(page);
        return [s.lifecycle, s.queue, s.status];
      },
      { timeout: 20_000 },
    )
    .toEqual(["LIVE", 0, "Live"]);
}
