// SPDX-License-Identifier: AGPL-3.0-or-later

import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { build, context } from "esbuild";
import { buildIdentifier } from "./build-metadata.mjs";

const dev = process.argv.includes("--dev");
const watch = process.argv.includes("--watch");
const requestedChannel = process.argv
  .find((argument) => argument.startsWith("--channel="))
  ?.split("=")[1];
const channel = dev ? "development" : (requestedChannel ?? "production");
if (!["development", "staging", "production"].includes(channel))
  throw new Error(`Unknown Relay build channel: ${channel}`);
if (dev && requestedChannel && requestedChannel !== "development")
  throw new Error("Development builds cannot target a hosted Relay channel");
const groups = true;
const extensionPackage = JSON.parse(
  await readFile(new URL("../apps/extension/package.json", import.meta.url), "utf8"),
);
const productVersion = extensionPackage.version;
const buildId = buildIdentifier();
const relayBuild = `Relay ${productVersion} (${buildId})`;
const disableGroupsForDevelopment = dev && process.env.RELAY_DISABLE_TAB_GROUPS === "1";
// Chrome match patterns cannot express private-IP CIDR ranges. This declaration is
// only a development permission *ceiling*; settings validates private origins and
// asks Chrome for the one exact origin entered by the user.
const developmentOrigins = ["http://*/*"];
const developmentLoopbackOrigins = ["http://localhost/*", "http://127.0.0.1/*", "http://[::1]/*"];
const out = new URL("../apps/extension/dist/", import.meta.url);
await mkdir(out, { recursive: true });
const hostedOrigins = {
  development: "",
  staging: "https://relay-staging.relay-sync.workers.dev",
  production: "https://relay.relay-sync.workers.dev",
};
let official = process.env.RELAY_OFFICIAL_ORIGIN || hostedOrigins[channel];
if (official) {
  const url = new URL(official);
  if (
    url.protocol !== "https:" ||
    url.hostname.includes("*") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Official server must be an HTTPS origin without credentials or a path");
  official = url.origin;
}
const repository = process.env.RELAY_REPOSITORY_URL || "https://github.com/jayamartinez/relay";
if (repository) {
  const url = new URL(repository);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Source repository must be an HTTPS URL without credentials");
}
const manifest = {
  manifest_version: 3,
  name: "Relay",
  version: productVersion,
  description:
    "End-to-end encrypted workspace synchronization. Built for Helium; independent and compatible with supported Chromium browsers.",
  minimum_chrome_version: "120",
  incognito: "not_allowed",
  permissions: ["tabs", "storage", "alarms", "webNavigation", "tabGroups"],
  host_permissions: [
    ...(official ? [`${new URL(official).origin}/*`] : []),
    ...(dev ? developmentLoopbackOrigins : []),
  ],
  optional_host_permissions: ["https://*/*", ...(dev ? developmentOrigins : [])],
  background: { service_worker: "background.js", type: "module" },
  action: { default_popup: "popup.html", default_title: "Relay" },
  options_ui: { page: "settings.html", open_in_tab: true },
  icons: { 16: "icon-16.png", 32: "icon-32.png", 48: "icon-48.png", 128: "icon-128.png" },
  content_security_policy: {
    extension_pages:
      "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'; connect-src https: wss:" +
      (dev ? " http: ws:" : "") +
      ";",
  },
};
await writeFile(new URL("manifest.json", out), JSON.stringify(manifest, null, 2));
for (const file of await readdir(new URL("../apps/extension/public/", import.meta.url)))
  if (file !== "page.html")
    await copyFile(
      new URL(`../apps/extension/public/${file}`, import.meta.url),
      new URL(file, out),
    );
await copyFile(
  new URL(
    "../node_modules/@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2",
    import.meta.url,
  ),
  new URL("instrument-sans-latin-wght-normal.woff2", out),
);
await copyFile(
  new URL("../node_modules/@fontsource-variable/instrument-sans/LICENSE", import.meta.url),
  new URL("instrument-sans-LICENSE.txt", out),
);
await unlink(new URL("page.html", out)).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
for (const stale of ["mark.svg", "placeholder.html", "placeholder.js", "placeholder.js.map"])
  await unlink(new URL(stale, out)).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
if (!dev)
  for (const entry of ["background", "settings", "popup"])
    await unlink(new URL(`${entry}.js.map`, out)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
for (const page of ["popup", "settings"]) {
  const template = await readFile(
    new URL("../apps/extension/public/page.html", import.meta.url),
    "utf8",
  );
  await writeFile(
    new URL(`${page}.html`, out),
    template.replaceAll("__PAGE__", page).replaceAll("__RELAY_BUILD__", relayBuild),
  );
}
// Rasterize the Relay mark (two overlapping windows on a blue tile) without an
// image/runtime dependency. Geometry matches the SVG mark in apps/extension/src/ui.ts.
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function insideRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}
for (const size of [16, 32, 48, 128]) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  const samples = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let tile = 0;
      let glyph = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const u = ((x + (sx + 0.5) / samples) / size) * 256;
          const v = ((y + (sy + 0.5) / samples) / size) * 256;
          if (!insideRoundRect(u, v, 0, 0, 256, 256, 67)) continue;
          tile++;
          const a = insideRoundRect(u, v, 51, 51, 167, 167, 29);
          const b = insideRoundRect(u, v, 89, 89, 205, 205, 29);
          if (a !== b) glyph++;
        }
      const total = samples * samples;
      const mix = tile ? glyph / tile : 0;
      const p = y * (size * 4 + 1) + 1 + x * 4;
      data.set(
        [
          Math.round(54 + (251 - 54) * mix),
          Math.round(83 + (252 - 83) * mix),
          Math.round(220 + (255 - 220) * mix),
          Math.round((tile / total) * 255),
        ],
        p,
      );
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  await writeFile(
    new URL(`icon-${size}.png`, out),
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(data)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
const options = {
  entryPoints: [
    "apps/extension/src/background.ts",
    "apps/extension/src/settings.ts",
    "apps/extension/src/popup.ts",
  ],
  bundle: true,
  format: "esm",
  outdir: out.pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  target: "chrome120",
  minify: !dev,
  sourcemap: dev ? "linked" : false,
  define: {
    __DEV__: JSON.stringify(dev),
    __DIAGNOSTICS__: JSON.stringify(
      dev && (process.env.RELAY_DIAGNOSTICS === "1" || process.argv.includes("--diagnostics")),
    ),
    __DISABLE_TAB_GROUPS_FOR_DEVELOPMENT__: JSON.stringify(disableGroupsForDevelopment),
    __BUILD_CHANNEL__: JSON.stringify(channel),
    __OFFICIAL_ORIGIN__: JSON.stringify(official),
    __REPOSITORY_URL__: JSON.stringify(repository),
    __PRODUCT_VERSION__: JSON.stringify(productVersion),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  tsconfig: "tsconfig.json",
  logLevel: "info",
};
// fileURLToPath also handles workspace spaces on Windows.
const { fileURLToPath } = await import("node:url");
options.outdir = fileURLToPath(out);
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else await build(options);
if (!watch) {
  for (const file of (await readdir(out)).filter((f) => /\.(js|css)$/.test(f))) {
    const data = await readFile(new URL(file, out));
    console.log(`${file}: ${data.length} bytes`);
  }
}
