// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const output = new URL("../apps/extension/dist/", import.meta.url);
const files = await readdir(output);
const manifest = JSON.parse(await readFile(new URL("manifest.json", output), "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "1.0.0");
assert.equal(manifest.incognito, "not_allowed");
assert.deepEqual(manifest.permissions, ["tabs", "storage", "alarms", "webNavigation", "tabGroups"]);
assert(!manifest.content_scripts && !manifest.externally_connectable);
assert(
  manifest.host_permissions.every(
    (origin) => origin.startsWith("https://") && !origin.includes("*://"),
  ),
);
assert.deepEqual(manifest.optional_host_permissions, ["https://*/*"]);
assert(!files.some((file) => file.endsWith(".map")), "Production source maps must not be packaged");
let total = 0;
for (const file of files) {
  const bytes = await readFile(new URL(file, output));
  total += bytes.length;
  if (file.endsWith(".js")) {
    const source = bytes.toString();
    assert(
      !/\beval\s*\(|new Function\s*\(|console\.(log|debug|info)\s*\(/.test(source),
      `Unexpected executable/logging pattern in ${file}`,
    );
    assert(!/sourceMappingURL/.test(source), `Source-map reference in ${file}`);
  }
  if (/\.(js|css)$/.test(file))
    console.log(`${file}: ${bytes.length} bytes, ${gzipSync(bytes).length} bytes gzip`);
}
console.log(
  `Production artifact: ${files.length} files, ${total} bytes. Manifest and bundle audit passed.`,
);
