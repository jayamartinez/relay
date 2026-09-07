import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { counter, enroll, profile, settle, tabs } from "../browser-fixture";

test("receiver SPA queries and redirects converge without reloads; remote close removes the physical tab", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/final" });
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end('<!doctype html><title>Test search</title><a href="/redirect">Redirect</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const a = await profile();
  const b = await profile();
  try {
    await enroll(a.page, b.page);
    await a.page.evaluate((url) => chrome.tabs.create({ url, active: false }), `${origin}/search`);
    await expect
      .poll(async () => (await tabs(b.page)).some((t) => t.url === `${origin}/search`))
      .toBe(true);
    await settle(b.page);
    const receiver = b.context.pages().find((p) => p.url() === `${origin}/search`)!;
    const before = await counter(b.page, "TAB_NAVIGATE.APPLY");
    await receiver.evaluate(() => {
      history.pushState({}, "", "/search?q=second");
      history.replaceState({}, "", "/search?q=third");
    });
    await expect
      .poll(async () => (await tabs(a.page)).some((t) => t.url === `${origin}/search?q=third`), {
        timeout: 15_000,
      })
      .toBe(true);
    await settle(a.page);
    await settle(b.page);
    expect(receiver.url()).toBe(`${origin}/search?q=third`);
    expect(await counter(b.page, "TAB_NAVIGATE.APPLY")).toBe(before);
    await receiver.getByRole("link", { name: "Redirect" }).click();
    await expect
      .poll(async () => (await tabs(a.page)).some((t) => t.url === `${origin}/final`))
      .toBe(true);
    await settle(b.page);
    expect(receiver.url()).toBe(`${origin}/final`);
    const physical = (await tabs(a.page)).find((t) => t.url === `${origin}/final`)!;
    await a.page.evaluate((id) => chrome.tabs.remove(id), physical.id!);
    await expect
      .poll(async () => (await tabs(b.page)).filter((t) => t.url?.startsWith(origin)).length)
      .toBe(0);
    await settle(b.page);
  } finally {
    await a.context.close();
    await b.context.close();
    server.close();
  }
});

test("idle settings retain their DOM across status reads and heartbeat intervals", async () => {
  test.setTimeout(240_000);
  const a = await profile();
  try {
    await a.page.getByRole("button", { name: "Create Relay account", exact: true }).click();
    await a.page.getByRole("checkbox").check();
    await a.page.getByRole("button", { name: "Start syncing", exact: true }).click();
    await settle(a.page);
    await a.page.waitForTimeout(1000);
    const brand = await a.page.locator(".brand").first().elementHandle();
    await a.page.waitForTimeout(Number(process.env.RELAY_IDLE_MS ?? 6500));
    expect(await brand!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    await a.context.close();
  }
});
