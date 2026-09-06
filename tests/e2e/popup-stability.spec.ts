import { expect, type Page, test } from "@playwright/test";
import { command, profile } from "../browser-fixture";

async function expectStableShell(popup: Page) {
  await expect(popup.locator("#app")).toBeVisible();
  await expect
    .poll(() =>
      popup.evaluate(() => {
        const app = document.getElementById("app")!;
        const style = getComputedStyle(app);
        return {
          minHeight: style.minHeight,
          minWidth: style.minWidth,
          atLeastMinimumHeight: app.getBoundingClientRect().height >= 300,
          fixedWidth: app.getBoundingClientRect().width === 340,
        };
      }),
    )
    .toEqual({
      minHeight: "300px",
      minWidth: "340px",
      atLeastMinimumHeight: true,
      fixedWidth: true,
    });
}

test("keeps a full popup shell through repeated opens and background lifecycle states", async () => {
  const relay = await profile();
  try {
    const extensionId = relay.worker.url().split("/")[2];
    const open = async () => {
      const popup = await relay.context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await expectStableShell(popup);
      await popup.close();
    };

    // A first-time popup is the path most likely to wait for service-worker initialization.
    await open();
    await relay.page.getByRole("button", { name: "Create Relay account", exact: true }).click();
    await command(relay.page, "start");
    for (let iteration = 0; iteration < 30; iteration++) await open();

    await command(relay.page, "pause", { value: true });
    await open();
    await command(relay.page, "pause", { value: false });
    await relay.context.setOffline(true);
    await open();
    await relay.context.setOffline(false);
  } finally {
    await relay.context.close();
  }
});
