import { expect, test, type Worker } from "@playwright/test";
import { command, profile, status } from "../browser-fixture";

// Only the disposable extension clock is offset. Fetch, crypto and the real
// Worker are unchanged, so these exercise signed, serialized wire requests.
async function offsetClock(worker: Worker, offset: number) {
  await worker.evaluate((offset) => {
    const clock = globalThis as typeof globalThis & { relayOriginalNow?: typeof Date.now };
    clock.relayOriginalNow ??= Date.now;
    Date.now = () => clock.relayOriginalNow!() + offset;
  }, offset);
}

test("failed pair-start stays retryable through reload; bounded skew pairs and recovers", async () => {
  const a = await profile();
  const b = await profile();
  const c = await profile();
  try {
    await a.page.getByRole("button", { name: "Create Relay account", exact: true }).click();
    await expect(
      a.page.getByRole("heading", { name: "Your Relay account", exact: true }),
    ).toBeVisible();
    const draft = await status(a.page);
    const health = await a.page.evaluate(async (server) => {
      return chrome.runtime.sendMessage({ action: "health", server });
    }, draft.server);
    expect(health.value.ok).toBe(true);
    await command(a.page, "start");
    await expect.poll(async () => (await status(a.page)).status).toBe("Live");
    expect((await status(a.page)).startTrace?.join("\n")).toContain(
      "create FETCH returned HTTP 200",
    );

    await b.page.getByRole("button", { name: "Enter account number", exact: true }).click();
    await b.page.getByLabel("24-digit account number").fill(draft.account!);
    await offsetClock(b.worker, 180_000);
    await b.page.getByRole("button", { name: "Request approval", exact: true }).click();
    await expect.poll(async () => (await status(b.page)).error).toContain("timestamp");
    expect((await status(b.page)).phase).toBe("draft");
    expect((await status(b.page)).pair).toBeUndefined();
    expect((await status(b.page)).startTrace?.join("\n")).toContain(
      "PAIR_REQUEST_TIMESTAMP_INVALID",
    );
    await expect(
      b.page.getByRole("button", { name: "Request approval", exact: true }),
    ).toBeVisible();
    await expect(
      b.page.getByRole("heading", { name: "Waiting for approval", exact: true }),
    ).toHaveCount(0);
    await expect(b.page.getByRole("button", { name: "Start syncing", exact: true })).toHaveCount(0);
    await b.page.reload();
    await expect(
      b.page.getByRole("button", { name: "Request approval", exact: true }),
    ).toBeVisible();
    await offsetClock(b.worker, 60_000);
    await b.page.getByRole("button", { name: "Request approval", exact: true }).click();
    await expect.poll(async () => (await status(b.page)).phase).toBe("pending");
    await expect.poll(async () => (await status(a.page)).approvals.length).toBe(1);
    const request = (await status(a.page)).approvals[0]!;
    await command(a.page, "review", { id: request.id });
    await expect
      .poll(async () => {
        await command(b.page, "status", { poll: true });
        return (await status(a.page)).approvals[0]?.sas;
      })
      .toBeTruthy();
    await command(b.page, "status", { poll: true });
    const code = (await status(a.page)).approvals[0]!.sas!;
    expect((await status(b.page)).pair?.sas).toBe(code);
    await command(a.page, "approve", { id: request.id, code });
    await command(b.page, "finish-pair", { code });
    await command(b.page, "merge");

    await c.page.getByRole("button", { name: "Enter account number", exact: true }).click();
    await c.page.getByRole("button", { name: "Use recovery key", exact: true }).click();
    await c.page.getByLabel("24-digit account number").fill(draft.account!);
    await c.page.getByLabel("Recovery key", { exact: true }).fill(draft.recovery!);
    await offsetClock(c.worker, 60_000);
    await c.page.getByRole("button", { name: "Recover account", exact: true }).click();
    await expect.poll(async () => (await status(c.page)).phase).toBe("merge");
    await command(c.page, "merge");
    await expect.poll(async () => (await status(c.page)).status).toBe("Live");
  } finally {
    await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
  }
});
