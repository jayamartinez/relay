import { expect, test } from "@playwright/test";
import { enroll, profile, settle, status, tabs } from "../browser-fixture";

test("recovers transport failure, offline journals and a remote edit during reconnect without Retry", async () => {
  const a = await profile(),
    b = await profile();
  const url = (name: string) =>
    `${process.env.RELAY_TEST_SERVER ?? "http://localhost:8787"}/transport-${name}`;
  const has = async (page: typeof a.page, name: string) =>
    (await tabs(page)).some((t) => t.url === url(name));
  try {
    await enroll(a.page, b.page);
    // Fail the real extension's transport, retaining the actual controller, journal,
    // signatures and local Durable Object. This also forces its existing socket shut.
    await b.worker.evaluate(() => {
      const state = globalThis as typeof globalThis & { relayFetch?: typeof fetch };
      state.relayFetch = fetch;
      globalThis.fetch = async () => {
        throw new TypeError("Failed to fetch");
      };
    });
    await b.page.evaluate(
      (url) => chrome.tabs.create({ url, active: false }),
      url("offline-local"),
    );
    await expect.poll(async () => (await status(b.page)).status).toBe("Offline");
    await expect.poll(async () => (await status(b.page)).queue).toBeGreaterThan(0);
    await a.page.evaluate(
      (url) => chrome.tabs.create({ url, active: false }),
      url("offline-remote"),
    );
    await settle(a.page);
    // Hold one real sync response after it has captured a revision. A later remote
    // edit must be found by the post-open pull, even though no socket exists yet.
    await b.worker.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        relayFetch?: typeof fetch;
        relayRelease?: () => void;
        relayHeld?: boolean;
      };
      const original = state.relayFetch!;
      globalThis.fetch = async (...args) => {
        const response = await original(...args);
        if (String(args[0]).endsWith("/sync") && !state.relayHeld) {
          state.relayHeld = true;
          await new Promise<void>((resolve) => {
            state.relayRelease = resolve;
          });
        }
        return response;
      };
    });
    await expect
      .poll(() => b.worker.evaluate(() => (globalThis as { relayHeld?: boolean }).relayHeld), {
        timeout: 35_000,
      })
      .toBe(true);
    await a.page.evaluate(
      (url) => chrome.tabs.create({ url, active: false }),
      url("during-reconnect"),
    );
    await settle(a.page);
    await b.worker.evaluate(() => (globalThis as { relayRelease?: () => void }).relayRelease?.());
    await expect.poll(() => has(b.page, "during-reconnect"), { timeout: 35_000 }).toBe(true);
    await expect.poll(() => has(b.page, "offline-remote")).toBe(true);
    await expect.poll(() => has(a.page, "offline-local")).toBe(true);
    await settle(b.page);
    await b.page.evaluate(
      (url) => chrome.tabs.create({ url, active: false }),
      url("after-recovery"),
    );
    await expect.poll(() => has(a.page, "after-recovery")).toBe(true);
    expect((await status(b.page)).runtime?.halted).toBe(false);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
