import { expect, test } from "@playwright/test";
import { counter, enroll, profile, settle, tabs } from "./browser-fixture";

// Explicit opt-in external-network probe; ordinary regression tests do not send Google searches.
test("one Google search records receiver applications without CAPTCHA workarounds", async ({}, info) => {
  const a = await profile();
  const b = await profile();
  try {
    await enroll(a.page, b.page);
    const created = await a.page.evaluate(() => chrome.tabs.create({ active: false }));
    await a.page.waitForTimeout(600);
    await settle(a.page);
    await settle(b.page);
    const before = await counter(b.page, "TAB_NAVIGATE.APPLY");
    const echoes = await counter(b.page, "TAB_NAVIGATE.EMIT");
    await a.page.evaluate(
      (id) =>
        chrome.tabs.update(id, {
          url: "https://www.google.com/search?q=relay+browser+sync+test",
        }),
      created.id!,
    );
    await expect
      .poll(async () => (await tabs(b.page)).some((t) => t.url?.includes("google.com/")), {
        timeout: 20_000,
      })
      .toBe(true);
    await b.page.waitForTimeout(5_000); // Bounded observation for asynchronous redirects and feedback.
    const results = [];
    for (const [name, instance] of [
      ["A", a],
      ["B", b],
    ] as const) {
      const google = instance.context.pages().find((p) => p.url().includes("google.com/"));
      const body = await google
        ?.locator("body")
        .innerText({ timeout: 5_000 })
        .catch(() => "");
      results.push({
        profile: name,
        reachedGoogleDocument: Boolean(google),
        captchaOrUnusualTraffic: /unusual traffic|not a robot|captcha/i.test(body ?? ""),
      });
    }
    const evidence = {
      receiverApplications: (await counter(b.page, "TAB_NAVIGATE.APPLY")) - before,
      receiverEchoes: (await counter(b.page, "TAB_NAVIGATE.EMIT")) - echoes,
      observationSeconds: 5,
      results,
    };
    console.log("Google probe (no URLs or account data):", evidence);
    await info.attach("google-navigation-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    expect(evidence.receiverApplications).toBe(1);
    expect(evidence.receiverEchoes).toBe(0);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
