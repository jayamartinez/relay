// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";

const BUILD_ID = /^(?:[0-9a-f]{7,64}|dev|unknown)(?:-dirty)?$/;

function git(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function shortBuildId(value) {
  return /^[0-9a-f]{7,64}$/.test(value) ? value.slice(0, 7) : value;
}

export function buildIdentifier(environment = process.env, runGit = git) {
  const supplied = environment.RELAY_BUILD_ID?.trim().toLowerCase();
  const fromGit = runGit(["rev-parse", "--short=7", "HEAD"]);
  const base = BUILD_ID.test(supplied ?? "")
    ? shortBuildId(supplied.replace(/-dirty$/, ""))
    : BUILD_ID.test(fromGit ?? "")
      ? fromGit
      : "unknown";
  const dirty = runGit(["status", "--porcelain"]);
  return dirty ? `${base}-dirty` : base;
}
