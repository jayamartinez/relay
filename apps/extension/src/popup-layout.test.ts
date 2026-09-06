// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const asset = (name: string) =>
  readFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), "utf8");

it("keeps the popup's first paint structurally sized before its background request resolves", async () => {
  const [html, css] = await Promise.all([asset("page.html"), asset("style.css")]);

  // The document is visible before popup.ts can call runtime.sendMessage. This shell is
  // therefore the browser's sizing input for a sleeping or reconnecting MV3 worker.
  expect(html).toMatch(/<main id="app"[^>]*>\s*<div class="popup-initial-shell">/);
  expect(html).toContain('class="popup-loading"');
  expect(html).toContain("Loading Relay status…");
  expect(html.indexOf('class="popup-loading"')).toBeLessThan(html.indexOf("__PAGE__.js"));
  expect(css).toMatch(/\.popup\s*\{[^}]*min-width:\s*340px;[^}]*min-height:\s*300px;/s);
  expect(css).toMatch(/\.popup main\s*\{[^}]*min-width:\s*340px;[^}]*min-height:\s*300px;/s);
  expect(css).toMatch(/\.popup \.popup-loading\s*\{[^}]*min-height:\s*156px;/s);
});
