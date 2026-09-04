import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";

test("supported live tab-group API probe in a disposable Chromium profile", async () => {
  // Generated probe extension, never a user's browser profile or internal persistence.
  const extension = path.resolve("output/playwright/group-api-probe");
  await mkdir(extension, { recursive: true });
  await writeFile(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Relay API probe",
      version: "1.0",
      permissions: ["tabs", "tabGroups"],
      background: { service_worker: "probe.js" },
    }),
  );
  await writeFile(
    path.join(extension, "probe.js"),
    "chrome.runtime.onInstalled.addListener(() => {});",
  );
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const result = await worker.evaluate(async () => {
      const a = await chrome.tabs.create({ url: "about:blank", active: false });
      const b = await chrome.tabs.create({ url: "about:blank", active: false });
      const id = await chrome.tabs.group({ tabIds: [a.id!, b.id!] });
      await chrome.tabGroups.update(id, { title: "Probe", color: "cyan", collapsed: true });
      const group = await chrome.tabGroups.get(id);
      const destination = await chrome.windows.create({ focused: false, type: "normal" });
      const moved = await chrome.tabGroups.move(id, { windowId: destination!.id!, index: -1 });
      const members = await chrome.tabs.query({ groupId: moved!.id });
      await chrome.tabs.ungroup(members.map((t) => t.id!) as [number, ...number[]]);
      return {
        version: navigator.userAgent,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        moved: moved!.windowId === destination!.id,
        members: members.length,
        remaining: (await chrome.tabGroups.query({})).length,
      };
    });
    expect(result).toMatchObject({
      title: "Probe",
      color: "cyan",
      collapsed: true,
      moved: true,
      members: 2,
      remaining: 0,
    });
    await test.info().attach("browser-api-evidence", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    console.log(result.version);
  } finally {
    await context.close();
  }
});
