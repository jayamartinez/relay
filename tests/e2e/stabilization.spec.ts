import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { counter, enroll, profile, settle, status, tabs, windows } from "../browser-fixture";

let origin: string;
const url = (name: string) => `${origin}/${name}`;
const web = async (page: Page) =>
  (await tabs(page)).filter((t) => t.url?.startsWith(url(""))).map((t) => t.url!);
async function seed(page: Page, names: string[]) {
  return page.evaluate(async (names) => {
    const old = await chrome.tabs.query({});
    const created = [];
    for (const name of names)
      created.push((await chrome.tabs.create({ url: name, active: false })).id!);
    for (const tab of old)
      if (tab.url === "about:blank" || tab.url?.startsWith("chrome://newtab"))
        await chrome.tabs.remove(tab.id!);
    return created;
  }, names.map(url));
}
test("live sync survives large changes, recovery, restart, and window shutdown", async () => {
  const contexts: BrowserContext[] = [];
  const loads = new Map<string, number>();
  const server = createServer((request, response) => {
    const destination = `${origin}${request.url}`;
    if (request.headers["sec-fetch-dest"] === "document")
      loads.set(destination, (loads.get(destination) ?? 0) + 1);
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end("<!doctype html><title>Relay test</title>Test page");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-stabilization-"));
  try {
    const a = await profile();
    contexts.push(a.context);
    let b = await profile(directory);
    contexts.push(b.context);
    const aIds = await seed(a.page, ["testing-123", "lol"]);
    const bIds = await seed(b.page, ["test-B", "tab-2"]);
    await expect.poll(() => loads.size).toBe(4);
    await enroll(a.page, b.page);
    const initial = ["testing-123", "lol", "test-B", "tab-2"].map(url);
    await expect.poll(() => web(a.page)).toEqual(initial);
    await expect.poll(() => web(b.page)).toEqual(initial);
    expect((await windows(a.page)).length).toBe(1);
    expect((await windows(b.page)).length).toBe(1);
    expect((await tabs(b.page)).filter((t) => bIds.includes(t.id!)).length).toBe(2);
    for (const destination of initial) await expect.poll(() => loads.get(destination)).toBe(2);

    const applied = await counter(b.page, "TAB_NAVIGATE.APPLY");
    const emitted = await counter(b.page, "TAB_NAVIGATE.EMIT");
    await a.page.evaluate(({ id, destination }) => chrome.tabs.update(id, { url: destination }), {
      id: aIds[0]!,
      destination: url("one-navigation"),
    });
    await expect.poll(async () => (await web(b.page))[0]).toBe(url("one-navigation"));
    await b.page.waitForTimeout(800); // Observe delayed browser callbacks, not an implementation poll.
    expect(loads.get(url("one-navigation"))).toBe(2);
    expect((await counter(b.page, "TAB_NAVIGATE.APPLY")) - applied).toBe(1);
    expect((await counter(b.page, "TAB_NAVIGATE.EMIT")) - emitted).toBe(0);
    await a.page.evaluate(
      async ({ id, destinations }) => {
        for (const destination of destinations) await chrome.tabs.update(id, { url: destination });
      },
      { id: aIds[0]!, destinations: ["rapid-A", "rapid-B", "rapid-C"].map(url) },
    );
    await expect.poll(async () => (await web(b.page))[0]).toBe(url("rapid-C"));
    expect(loads.get(url("rapid-A")) ?? 0).toBeLessThanOrEqual(1);
    expect(loads.get(url("rapid-B")) ?? 0).toBeLessThanOrEqual(1);
    await expect.poll(() => loads.get(url("rapid-C"))).toBe(2);

    // A realistic large mutation must leave both controllers capable of future live work.
    const massIds = await a.page.evaluate(
      async (destinations) =>
        Promise.all(
          destinations.map(
            async (destination) =>
              (await chrome.tabs.create({ url: destination, active: false })).id!,
          ),
        ),
      Array.from({ length: 70 }, (_, index) => url(`mass-${index % 11}-${index}`)),
    );
    await expect
      .poll(async () => (await web(b.page)).filter((value) => value.includes("/mass-")).length, {
        timeout: 30_000,
      })
      .toBe(70);
    await a.page.evaluate((ids) => chrome.tabs.remove(ids), massIds);
    await expect
      .poll(async () => (await web(b.page)).filter((value) => value.includes("/mass-")).length, {
        timeout: 30_000,
      })
      .toBe(0);
    await a.page.evaluate(
      (destination) => chrome.tabs.create({ url: destination, active: false }),
      url("after-mass-close"),
    );
    await expect.poll(async () => (await web(b.page)).includes(url("after-mass-close"))).toBe(true);
    await settle(a.page);
    await settle(b.page);

    // A closed transport reconnects without reloading the extension.
    await b.context.setOffline(true);
    await a.page.waitForTimeout(500);
    await a.page.evaluate(
      (destination) => chrome.tabs.create({ url: destination, active: false }),
      url("during-network-loss"),
    );
    await b.context.setOffline(false);
    await expect
      .poll(async () => (await web(b.page)).includes(url("during-network-loss")), {
        timeout: 30_000,
      })
      .toBe(true);
    await settle(b.page);

    // Terminating the MV3 worker must reconnect and continue receiving later changes.
    const workerSession = await b.context.newCDPSession(b.page);
    await workerSession.send("ServiceWorker.enable");
    await workerSession.send("ServiceWorker.stopAllWorkers");
    await a.page.evaluate(
      (destination) => chrome.tabs.create({ url: destination, active: false }),
      url("after-worker-restart"),
    );
    await expect
      .poll(async () => (await web(b.page)).includes(url("after-worker-restart")), {
        timeout: 30_000,
      })
      .toBe(true);
    await settle(b.page);
    const beforeLocal = await web(b.page);
    await a.page.evaluate(() =>
      chrome.tabs.create({ url: "chrome://extensions", index: 1, active: false }),
    );
    await a.page.waitForTimeout(800);
    expect(await web(b.page)).toEqual(beforeLocal);
    expect((await tabs(b.page)).some((t) => t.url?.includes("placeholder"))).toBe(false);

    const second = await b.page.evaluate(
      (destination) => chrome.windows.create({ url: destination, focused: false }),
      url("second-window"),
    );
    await expect.poll(async () => (await windows(a.page)).length).toBe(2);
    await settle(b.page);
    const deleted = await counter(b.page, "WINDOW_DELETE.EMIT");
    const tabsDeleted = await counter(b.page, "TAB_DELETE.EMIT");
    await b.page.evaluate((id) => chrome.windows.remove(id), second!.id!);
    await expect.poll(async () => (await windows(a.page)).length).toBe(1);
    expect((await counter(b.page, "WINDOW_DELETE.EMIT")) - deleted).toBe(1);
    expect((await counter(b.page, "TAB_DELETE.EMIT")) - tabsDeleted).toBe(0);

    // A non-normal control window keeps the test connection alive after the last normal window closes.
    const popupPage = b.context.waitForEvent("page");
    await b.page.evaluate(() =>
      chrome.windows.create({
        type: "popup",
        url: chrome.runtime.getURL("settings.html"),
        focused: false,
      }),
    );
    const control = await popupPage;
    await control.waitForLoadState();
    const normal = (await windows(control))[0]!;
    const fresh = await control.evaluate(
      (id) => chrome.tabs.create({ windowId: id, active: false }),
      normal.id!,
    );
    await control.evaluate(({ id, destination }) => chrome.tabs.update(id, { url: destination }), {
      id: fresh.id!,
      destination: url("before-exit"),
    });
    await expect.poll(async () => (await web(a.page)).includes(url("before-exit"))).toBe(true);
    await settle(control);
    const preserved = await web(a.page);
    const deleteBefore = [
      await counter(control, "WINDOW_DELETE.EMIT"),
      await counter(control, "TAB_DELETE.EMIT"),
    ];
    await control.evaluate((id) => chrome.windows.remove(id), normal.id!);
    await expect.poll(async () => (await status(control)).lifecycle).toBe("STOPPED");
    expect(await web(a.page)).toEqual(preserved);
    expect([
      await counter(control, "WINDOW_DELETE.EMIT"),
      await counter(control, "TAB_DELETE.EMIT"),
    ]).toEqual(deleteBefore);

    await control.evaluate(() => chrome.windows.create({ focused: false }));
    await settle(control);
    await expect.poll(() => web(control)).toEqual(preserved);
    expect((await windows(control)).length).toBe(1);
    await control.evaluate(
      (destination) => chrome.windows.create({ url: destination, focused: false }),
      url("exit-window-2"),
    );
    await expect.poll(async () => (await windows(a.page)).length).toBe(2);
    await settle(control);
    const multiPreserved = (await web(a.page)).sort();
    const multiDeletes = [
      await counter(control, "WINDOW_DELETE.EMIT"),
      await counter(control, "TAB_DELETE.EMIT"),
    ];
    const closing = await windows(control);
    await control.evaluate((id) => chrome.windows.remove(id), closing[0]!.id!);
    await control.waitForTimeout(250);
    await control.evaluate((id) => chrome.windows.remove(id), closing[1]!.id!);
    await expect.poll(async () => (await status(control)).lifecycle).toBe("STOPPED");
    expect((await web(a.page)).sort()).toEqual(multiPreserved);
    expect((await windows(a.page)).length).toBe(2);
    expect([
      await counter(control, "WINDOW_DELETE.EMIT"),
      await counter(control, "TAB_DELETE.EMIT"),
    ]).toEqual(multiDeletes);

    await b.context.close();
    const reopening = profile(directory);
    await a.page.evaluate(
      (destination) => chrome.tabs.create({ url: destination, active: false }),
      url("during-remote-reconcile"),
    );
    b = await reopening;
    contexts.push(b.context);
    await settle(b.page);
    await expect
      .poll(async () => (await web(b.page)).includes(url("during-remote-reconcile")), {
        timeout: 30_000,
      })
      .toBe(true);
    expect((await windows(b.page)).length).toBe(2);
    expect((await windows(a.page)).length).toBe(2);
  } finally {
    for (const context of contexts) await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
