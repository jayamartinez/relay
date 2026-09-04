import path from "node:path";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import type { Status } from "../../apps/extension/src/controller";
import { groupScenario } from "../group-scenario";

const extension = path.resolve("apps/extension/dist");
async function profile() {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = worker.url().split("/")[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/settings.html`);
  return { context, page, worker };
}
async function command(
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
const status = (page: Page) => command(page, "status");
async function tabs(page: Page) {
  return page.evaluate(() => chrome.tabs.query({}));
}
test("real two-profile pairing, tabs, offline resume, revocation and recovery", async () => {
  const profiles: BrowserContext[] = [];
  try {
    const a = await profile();
    profiles.push(a.context);
    const b = await profile();
    profiles.push(b.context);
    // This is the normal user gesture that grants the chosen server permission.
    await a.page.getByRole("button", { name: "Create Relay account", exact: true }).click();
    await expect(
      a.page.getByRole("heading", { name: "Your Relay account", exact: true }),
    ).toBeVisible();
    const draft = await status(a.page);
    const account = draft.account!;
    const recovery = draft.recovery!;
    await a.page.getByRole("checkbox").check();
    await a.page.getByRole("button", { name: "Start syncing", exact: true }).click();
    await expect.poll(async () => (await status(a.page)).phase).toBe("active");
    await b.page.getByRole("button", { name: "Enter account number", exact: true }).click();
    await b.page.getByLabel("24-digit account number").fill(account);
    await b.page.getByRole("button", { name: "Request approval", exact: true }).click();
    await expect.poll(async () => (await status(a.page)).approvals.length).toBe(1);
    const request = (await status(a.page)).approvals[0]!;
    await command(a.page, "review", { id: request.id });
    await expect
      .poll(async () => {
        await command(b.page, "status", { poll: true });
        return (await status(a.page)).approvals[0]?.sas;
      })
      .toBeTruthy();
    const code = (await status(a.page)).approvals[0]!.sas!;
    await command(b.page, "status", { poll: true });
    expect((await status(b.page)).pair?.sas).toBe(code);
    await command(a.page, "approve", { id: request.id, code });
    await command(b.page, "finish-pair", { code });
    await command(b.page, "merge");
    await expect.poll(async () => (await status(b.page)).status).toBe("Live");
    await groupScenario(a.page, b.page);
    await b.context.setOffline(true);
    await b.page.evaluate(() =>
      chrome.tabs.create({ url: "https://example.com/?relay=network-outage", active: false }),
    );
    await expect
      .poll(async () => (await status(b.page)).queue, { timeout: 20_000 })
      .toBeGreaterThan(0);
    await b.context.setOffline(false);
    await command(b.page, "retry");
    await expect
      .poll(
        async () =>
          (await tabs(a.page)).filter((t) => t.url?.includes("relay=network-outage")).length,
      )
      .toBe(1);
    const opened = await a.page.evaluate(() =>
      chrome.tabs.create({ url: "https://example.com/?relay=e2e", active: false }),
    );
    await expect
      .poll(async () => (await tabs(b.page)).filter((t) => t.url?.includes("relay=e2e")).length)
      .toBe(1);
    const remote = (await tabs(b.page)).find((t) => t.url?.includes("relay=e2e"))!;
    await b.page.evaluate(
      (id) => chrome.tabs.update(id, { url: "https://example.com/?relay=navigated", pinned: true }),
      remote.id!,
    );
    await expect
      .poll(async () => (await tabs(a.page)).find((t) => t.id === opened.id)?.url)
      .toContain("relay=navigated");
    await expect
      .poll(async () => (await tabs(a.page)).find((t) => t.id === opened.id)?.pinned)
      .toBe(true);
    const moved = await a.page.evaluate(
      (id) => chrome.windows.create({ tabId: id, focused: false }),
      opened.id!,
    );
    expect(moved?.id).toBeTruthy();
    await expect
      .poll(async () => (await tabs(b.page)).find((t) => t.id === remote.id)?.windowId)
      .not.toBe(remote.windowId);
    await command(b.page, "pause", { value: true });
    await b.page.evaluate(() =>
      chrome.tabs.create({ url: "https://example.com/?relay=queued", active: false }),
    );
    await expect.poll(async () => (await status(b.page)).queue).toBeGreaterThan(0);
    await a.page.evaluate(
      (id) => chrome.tabs.update(id, { url: "https://example.com/?relay=offline" }),
      opened.id!,
    );
    await expect.poll(async () => (await status(a.page)).queue).toBe(0);
    await command(b.page, "pause", { value: false });
    await expect
      .poll(async () => (await tabs(a.page)).filter((t) => t.url?.includes("relay=queued")).length)
      .toBe(1);
    await expect
      .poll(async () => (await tabs(b.page)).filter((t) => t.url?.includes("relay=offline")).length)
      .toBe(1);
    await a.page.evaluate((id) => chrome.tabs.remove(id), opened.id!);
    await expect
      .poll(async () => (await tabs(b.page)).filter((t) => t.url?.includes("relay=offline")).length)
      .toBe(0);
    // Protected pages remain entirely local and never add placeholder/spacing tabs.
    const beforeProtected = (await tabs(b.page)).length;
    const special = await a.page.evaluate(() =>
      chrome.tabs.create({ url: "chrome://settings/", active: false }),
    );
    await expect
      .poll(
        async () => (await tabs(b.page)).filter((t) => t.url?.includes("placeholder.html#")).length,
      )
      .toBe(0);
    await a.page.evaluate((id) => chrome.tabs.remove(id), special.id!);
    expect((await tabs(b.page)).length).toBe(beforeProtected);
    await expect
      .poll(
        async () => (await tabs(b.page)).filter((t) => t.url?.includes("placeholder.html#")).length,
      )
      .toBe(0);
    // Stop the actual MV3 worker, then wake it through a normal extension message.
    const cdp = await b.context.newCDPSession(b.page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await expect.poll(async () => (await status(b.page)).phase).toBe("active");
    await expect.poll(async () => (await status(b.page)).status).toBe("Live");
    const bDevice = (await status(b.page)).device!;
    await command(a.page, "revoke", { id: bDevice });
    await expect.poll(async () => (await status(b.page)).phase).toBe("welcome");
    expect((await status(a.page)).epoch).toBe(2);
    // Recovery after rotation on a fresh third profile exercises the saved recovery code.
    const c = await profile();
    profiles.push(c.context);
    await c.page.getByRole("button", { name: "Enter account number", exact: true }).click();
    await c.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
    await c.page.getByLabel("24-digit account number").fill(account);
    await expect(
      command(c.page, "recover", {
        server: "http://localhost:8787",
        account,
        name: "Recovery test device",
        code: "0".repeat(64),
      }),
    ).rejects.toThrow();
    await c.page.getByLabel("Recovery key", { exact: true }).fill(recovery);
    await c.page.getByRole("button", { name: "Recover account", exact: true }).click();
    await expect.poll(async () => (await status(c.page)).phase).toBe("merge");
    await command(c.page, "merge");
    expect((await status(c.page)).epoch).toBe(2);
    await expect.poll(async () => (await status(c.page)).status).toBe("Live");
    await a.page.reload();
    await a.page.screenshot({
      path: "output/playwright/settings.png",
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    for (const context of profiles) await context.close();
  }
});
