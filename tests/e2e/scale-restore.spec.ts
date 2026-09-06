import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enroll, profile, settle, status, tabs } from "../browser-fixture";

test("20/70/200 live tabs, five windows, twenty groups and native Chromium session restore", async () => {
  test.setTimeout(240_000);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Fixture</title>Relay fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-native-restore-"));
  const a = await profile();
  let b = await profile(directory, true);
  const portable = async (page: typeof a.page) =>
    (await tabs(page)).filter((t) => t.url?.startsWith(origin));
  try {
    for (const p of [a.page, b.page])
      await p.evaluate(async () => {
        for (const t of await chrome.tabs.query({}))
          if (t.url === "about:blank" || t.url?.startsWith("chrome://newtab"))
            await chrome.tabs.remove(t.id!);
      });
    await a.page.evaluate(async (origin) => {
      for (let i = 0; i < 20; i++)
        await chrome.tabs.create({
          url: `${origin}/duplicate-${i % 11}`,
          active: false,
          pinned: i === 0,
        });
    }, origin);
    await enroll(a.page, b.page);
    for (const count of [20, 70, 200]) {
      const current = (await portable(a.page)).length;
      await a.page.evaluate(
        async ({ origin, current, count }) => {
          for (let i = current; i < count; i++)
            await chrome.tabs.create({ url: `${origin}/duplicate-${i % 11}`, active: false });
        },
        { origin, current, count },
      );
      await expect
        .poll(async () => (await portable(b.page)).length, { timeout: 45_000 })
        .toBe(count);
      await settle(a.page);
      await settle(b.page);
    }
    await a.page.evaluate(async (origin) => {
      const all = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(origin));
      const windows = [all[0]!.windowId];
      for (let w = 1; w < 5; w++) {
        const moved = all.slice(w * 40, (w + 1) * 40);
        const window = await chrome.windows.create({ tabId: moved[0]!.id!, focused: false });
        windows.push(window!.id!);
        await chrome.tabs.move(
          moved.slice(1).map((t) => t.id!),
          { windowId: window!.id!, index: -1 },
        );
      }
      for (const [w, windowId] of windows.entries()) {
        const members = (await chrome.tabs.query({ windowId })).filter(
          (t) => t.url?.startsWith(origin) && !t.pinned,
        );
        for (let g = 0; g < 4; g++) {
          const id = await chrome.tabs.group({
            tabIds: members.slice(g * 3, g * 3 + 3).map((t) => t.id!) as [number, ...number[]],
          });
          await chrome.tabGroups.update(id, {
            title: `Group ${w}-${g}`,
            color: "blue",
            collapsed: false,
          });
        }
      }
    }, origin);
    await expect
      .poll(async () => b.page.evaluate(async () => (await chrome.tabGroups.query({})).length), {
        timeout: 45_000,
      })
      .toBe(20);
    await expect.poll(async () => (await status(b.page)).workspace?.windows).toBe(5);
    await settle(a.page);
    await settle(b.page);
    await b.page.evaluate(async () => {
      for (const group of await chrome.tabGroups.query({}))
        await chrome.tabGroups.update(group.id, { collapsed: true });
    });
    await b.page.waitForTimeout(500);
    expect(
      await a.page.evaluate(async () =>
        (await chrome.tabGroups.query({})).every((g) => !g.collapsed),
      ),
    ).toBe(true);
    const before = (await portable(b.page)).map((t) => t.url).sort();
    await b.context.close();
    b = await profile(directory, true);
    await settle(b.page);
    await expect
      .poll(async () => (await portable(b.page)).map((t) => t.url).sort(), { timeout: 45_000 })
      .toEqual(before);
    expect(
      await b.page.evaluate(
        async () => (await chrome.tabGroups.query({})).filter((g) => g.collapsed).length,
      ),
    ).toBe(20);
    expect((await status(b.page)).workspace?.windows).toBe(5);
    const id = (await portable(b.page))[0]!.id!;
    await b.page.evaluate(
      ({ id, origin }) => chrome.tabs.update(id, { url: `${origin}/after-native-restore` }),
      { id, origin },
    );
    await expect
      .poll(
        async () =>
          (await portable(a.page)).some((t) => t.url === `${origin}/after-native-restore`),
        { timeout: 30_000 },
      )
      .toBe(true);
    const runtime = (await status(b.page)).runtime;
    expect(runtime?.halted).toBe(false);
    await test.info().attach("scale-diagnostics", {
      body: JSON.stringify(runtime),
      contentType: "application/json",
    });
  } finally {
    await a.context.close();
    await b.context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
