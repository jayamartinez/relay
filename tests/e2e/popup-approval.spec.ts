import { expect, test } from "@playwright/test";
import { command, profile, status } from "../browser-fixture";

test("approves in the popup, updates the badge, and continues after the popup closes", async () => {
  const authorized = await profile();
  const joining = await profile();
  try {
    await authorized.page
      .getByRole("button", { name: "Create Relay account", exact: true })
      .click();
    await expect(
      authorized.page.getByRole("heading", { name: "Your Relay account", exact: true }),
    ).toBeVisible();
    const account = (await status(authorized.page)).account!;
    await command(authorized.page, "start");
    await expect.poll(async () => (await status(authorized.page)).phase).toBe("active");

    await joining.page.getByRole("button", { name: "Enter account number", exact: true }).click();
    await joining.page.getByLabel("24-digit account number").fill(account);
    await joining.page.getByRole("button", { name: "Request approval", exact: true }).click();
    await expect.poll(async () => (await status(authorized.page)).approvals.length).toBe(1);
    await expect
      .poll(() => authorized.page.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("1");

    const extensionId = authorized.worker.url().split("/")[2];
    const popup = await authorized.context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole("heading", { name: "New device", exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        await command(joining.page, "status", { poll: true });
        return (await status(authorized.page)).approvals[0]?.sas;
      })
      .toBeTruthy();
    const code = (await status(authorized.page)).approvals[0]!.sas!;
    await expect(popup.getByText(code, { exact: true })).toBeVisible();
    expect((await status(joining.page)).pair?.sas).toBe(code);
    expect(
      await popup.evaluate(() => ({
        clientWidth: document.body.clientWidth,
        scrollWidth: document.body.scrollWidth,
      })),
    ).toEqual({ clientWidth: 340, scrollWidth: 340 });
    await popup.locator("main").screenshot({ path: "output/playwright/popup-device-approval.png" });

    const approve = popup.getByRole("button", { name: "Approve", exact: true });
    await approve.focus();
    await approve.press("Enter");
    await popup.close();
    await expect
      .poll(async () => (await status(authorized.page)).approvalActivity?.status)
      .toBe("approved");
    await expect.poll(async () => (await status(authorized.page)).approvals.length).toBe(0);
    await expect
      .poll(() => authorized.page.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("");

    await command(joining.page, "status", { poll: true });
    await command(joining.page, "finish-pair", { code });
    await command(joining.page, "merge");
    await expect.poll(async () => (await status(joining.page)).phase).toBe("active");
  } finally {
    await Promise.all([authorized.context.close(), joining.context.close()]);
  }
});

test("keeps multiple requests distinct, restores their badge, and denies only the selected request", async () => {
  const authorized = await profile();
  const firstJoining = await profile();
  const secondJoining = await profile();
  try {
    await authorized.page
      .getByRole("button", { name: "Create Relay account", exact: true })
      .click();
    await expect(
      authorized.page.getByRole("heading", { name: "Your Relay account", exact: true }),
    ).toBeVisible();
    const account = (await status(authorized.page)).account!;
    await command(authorized.page, "start");

    for (const joining of [firstJoining, secondJoining]) {
      await joining.page.getByRole("button", { name: "Enter account number", exact: true }).click();
      await joining.page.getByLabel("24-digit account number").fill(account);
      await joining.page.getByRole("button", { name: "Request approval", exact: true }).click();
    }
    await expect.poll(async () => (await status(authorized.page)).approvals.length).toBe(2);
    const originalIds = (await status(authorized.page)).approvals.map((request) => request.id);
    await expect
      .poll(() => authorized.page.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("2");

    const cdp = await authorized.context.newCDPSession(authorized.page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await expect.poll(async () => (await status(authorized.page)).approvals.length).toBe(2);
    await expect
      .poll(() => authorized.page.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("2");

    const extensionId = authorized.worker.url().split("/")[2];
    const popup = await authorized.context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole("heading", { name: "Request 1 of 2", exact: true })).toBeVisible();
    await popup.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(async () => (await status(authorized.page)).approvals.length).toBe(1);
    const remainingId = (await status(authorized.page)).approvals[0]!.id;
    expect(originalIds).toContain(remainingId);
    expect((await status(authorized.page)).devices).toHaveLength(1);
    await expect
      .poll(() => authorized.page.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("1");

    await expect(popup.getByRole("heading", { name: "New device", exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await popup.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(async () => (await status(authorized.page)).approvals.length).toBe(0);
    await expect
      .poll(() => authorized.page.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("");
  } finally {
    await Promise.all([
      authorized.context.close(),
      firstJoining.context.close(),
      secondJoining.context.close(),
    ]);
  }
});
