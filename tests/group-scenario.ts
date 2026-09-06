import { expect, type Page } from "@playwright/test";

async function groups(page: Page) {
  return page.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return (await chrome.tabGroups.query({})).map((g) => ({
      ...g,
      members: tabs
        .filter((t) => t.groupId === g.id)
        .sort((a, b) => a.index - b.index)
        .map((t) => ({ id: t.id!, url: t.url, index: t.index })),
    }));
  });
}
export async function groupScenario(a: Page, b: Page) {
  expect(await a.evaluate(() => typeof chrome.tabGroups?.query)).toBe("function");
  const ids = await a.evaluate(async () => {
    const tabs = [];
    for (const name of ["one", "two", "three"])
      tabs.push(
        (await chrome.tabs.create({ url: `https://example.com/?group=${name}`, active: false }))
          .id!,
      );
    const group = await chrome.tabs.group({ tabIds: [tabs[0]!, tabs[1]!] });
    await chrome.tabGroups.update(group, { title: "Relay group test", color: "blue" });
    return { tabs, group };
  });
  await expect
    .poll(async () => (await groups(b)).find((g) => g.title === "Relay group test")?.members.length)
    .toBe(2);
  const remote = (await groups(b)).find((g) => g.title === "Relay group test")!;
  const second = await a.evaluate(async ({ tabs }) => {
    const id = await chrome.tabs.group({ tabIds: tabs[2]! });
    await chrome.tabGroups.update(id, { title: "Other group", color: "yellow" });
    return id;
  }, ids);
  await expect.poll(async () => (await groups(b)).length).toBe(2);
  const firstIndex = (await groups(a)).find((g) => g.id === ids.group)!.members[0]!.index;
  await a.evaluate(({ id, index }) => chrome.tabGroups.move(id, { index }), {
    id: second,
    index: firstIndex,
  });
  await expect
    .poll(async () => {
      const current = await groups(b);
      return (
        current.find((g) => g.title === "Other group")!.members[0]!.index <
        current.find((g) => g.title === "Relay group test")!.members[0]!.index
      );
    })
    .toBe(true);
  await a.evaluate((id) => chrome.tabs.ungroup(id), ids.tabs[2]!);
  await expect.poll(async () => (await groups(b)).length).toBe(1);
  await b.evaluate(
    (id) => chrome.tabGroups.update(id, { title: "Renamed", color: "purple", collapsed: true }),
    remote.id,
  );
  await expect
    .poll(async () => (await groups(a)).find((g) => g.id === ids.group)?.title)
    .toBe("Renamed");
  expect((await groups(a)).find((g) => g.id === ids.group)).toMatchObject({
    color: "purple",
    collapsed: false,
  });
  expect((await groups(b)).find((g) => g.title === "Renamed")?.collapsed).toBe(true);
  // Actual MV3 termination must retain group mapping and avoid re-creating native groups.
  const cdp = await b.context().newCDPSession(b);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await expect
    .poll(async () =>
      b.evaluate(async () => (await chrome.runtime.sendMessage({ action: "status" })).value.status),
    )
    .toBe("Live");
  expect((await groups(b)).find((g) => g.title === "Renamed")?.id).toBe(remote.id);
  await a.evaluate((id) => chrome.tabGroups.update(id, { color: "cyan" }), ids.group);
  await expect
    .poll(async () => (await groups(b)).find((g) => g.title === "Renamed")?.color)
    .toBe("cyan");
  expect((await groups(b)).find((g) => g.title === "Renamed")?.collapsed).toBe(true);
  // Add a member, reorder within the group, and then move the entire block to another window.
  await a.evaluate(async ({ group, tabs }) => {
    await chrome.tabs.group({ groupId: group, tabIds: tabs[2]! });
    const members = await chrome.tabs.query({ groupId: group });
    const first = Math.min(...members.map((t) => t.index));
    // The earlier block move can already put "three" first. Use the actual group
    // boundary, not the current position of the tab originally named "one".
    await chrome.tabs.move(tabs[2]!, { index: first });
    await chrome.tabs.move(tabs[0]!, { index: first + 1 });
    await chrome.tabs.move(tabs[1]!, { index: first + 2 });
  }, ids);
  expect(
    (await groups(a))
      .find((g) => g.title === "Renamed")
      ?.members.map((t) => t.url?.split("group=")[1]),
    "Source browser order after the supported native move",
  ).toEqual(["three", "one", "two"]);
  await expect
    .poll(async () =>
      (await groups(b))
        .find((g) => g.title === "Renamed")
        ?.members.map((t) => t.url?.split("group=")[1]),
    )
    .toEqual(["three", "one", "two"]);
  const oldRemoteWindow = (await groups(b)).find((g) => g.title === "Renamed")!.windowId;
  await a.evaluate(async (id) => {
    const destination = await chrome.windows.create({
      url: "https://example.com/?group=destination",
      focused: false,
    });
    await chrome.tabGroups.move(id, { windowId: destination!.id!, index: -1 });
  }, ids.group);
  await expect
    .poll(async () => (await groups(b)).find((g) => g.title === "Renamed")?.windowId)
    .not.toBe(oldRemoteWindow);
  await expect
    .poll(async () => (await groups(b)).find((g) => g.title === "Renamed")?.members.length)
    .toBe(3);
  expect((await groups(b)).find((g) => g.title === "Renamed")?.collapsed).toBe(true);
  // Local pause still journals group edits; they converge after reconnect.
  await b.evaluate(() => chrome.runtime.sendMessage({ action: "pause", value: true }));
  const remoteMoved = (await groups(b)).find((g) => g.title === "Renamed")!;
  await b.evaluate(
    (id) => chrome.tabGroups.update(id, { title: "Offline group", color: "orange" }),
    remoteMoved.id,
  );
  await expect
    .poll(async () =>
      b.evaluate(async () => (await chrome.runtime.sendMessage({ action: "status" })).value.queue),
    )
    .toBeGreaterThan(0);
  await b.evaluate(() => chrome.runtime.sendMessage({ action: "pause", value: false }));
  await expect
    .poll(async () => (await groups(a)).find((g) => g.title === "Offline group")?.color)
    .toBe("orange");
  // Remove one member, then ungroup the rest. Every tab remains open.
  await a.evaluate((id) => chrome.tabs.ungroup(id), ids.tabs[0]!);
  await expect
    .poll(async () => (await groups(b)).find((g) => g.title === "Offline group")?.members.length)
    .toBe(2);
  const remaining = (await groups(a))
    .find((g) => g.title === "Offline group")!
    .members.map((t) => t.id);
  await a.evaluate((tabIds) => chrome.tabs.ungroup(tabIds as [number, ...number[]]), remaining);
  await expect.poll(async () => (await groups(b)).length).toBe(0);
  expect(
    await b.evaluate(
      async () =>
        (await chrome.tabs.query({})).filter((t) => /group=(one|two|three)$/.test(t.url ?? ""))
          .length,
    ),
  ).toBe(3);
}
