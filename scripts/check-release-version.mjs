// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile } from "node:fs/promises";

const tag = process.argv[2];
if (!tag) throw new Error("Usage: node scripts/check-release-version.mjs <tag>");

const expectedVersion = tag.replace(/^v/, "");
const extension = JSON.parse(
  await readFile(new URL("../apps/extension/package.json", import.meta.url), "utf8"),
);

if (extension.version !== expectedVersion)
  throw new Error(
    `Release tag ${tag} does not match apps/extension/package.json version ${extension.version}`,
  );

console.log(`Release tag ${tag} matches extension version ${extension.version}`);
