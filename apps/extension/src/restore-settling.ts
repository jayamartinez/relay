// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Workspace } from "@relay/protocol";
import { canonical } from "@relay/shared";
import type { Mapping, ObservedWindow } from "./browser-model";
import { restoreMapping } from "./workspace-lifecycle";

export const RESTORE_POLL_MS = 200;
export const RESTORE_COMPLETE_STABLE_MS = 400;
export const RESTORE_PARTIAL_STABLE_MS = 1_200;
export const RESTORE_PARTIAL_GRACE_MS = 2_000;
export const RESTORE_MAX_WAIT_MS = 15_000;

export interface RestoreSample {
  actual: ObservedWindow[];
  mapping: Mapping;
  complete: boolean;
  fingerprint: string;
}

interface RestoreSettlingOptions {
  read: () => Promise<ObservedWindow[]>;
  previous: Mapping;
  target: Workspace;
  session: string;
  source: string;
  origin: string;
  quietAt: () => number;
  sampled?: (sample: RestoreSample) => void;
  now?: () => number;
  wait?: (delay: number) => Promise<void>;
  maximumWait?: number;
}

function fingerprint(actual: ObservedWindow[]) {
  return canonical(
    actual.map((window) => ({
      local: window.local,
      tabs: window.tabs.map((tab) => ({
        local: tab.local,
        index: tab.index,
        pinned: tab.pinned,
        incognito: tab.incognito,
        url: tab.url,
      })),
      groups: window.groups?.map((group) => ({
        local: group.local,
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        tabs: group.tabs,
      })),
    })),
  );
}

/**
 * Waits for native Chromium restoration to stop making progress. Complete restores
 * settle quickly; partial restores receive a longer grace period before Relay fills
 * genuine canonical gaps. This is bounded observation, not a fixed startup sleep.
 */
export async function settleBrowserRestore(
  options: RestoreSettlingOptions,
): Promise<RestoreSample> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const started = now();
  let changedAt = started;
  let priorFingerprint = "";
  let seed = options.previous;
  let latest!: RestoreSample;

  while (true) {
    const actual = await options.read();
    const restored = restoreMapping(
      actual,
      seed,
      options.target,
      options.session,
      options.source,
      options.origin,
    );
    seed = restored.mapping;
    const currentFingerprint = fingerprint(actual);
    const time = now();
    if (currentFingerprint !== priorFingerprint) {
      priorFingerprint = currentFingerprint;
      changedAt = time;
    }
    const mapped = new Set(Object.values(seed.tabs));
    const complete = Object.keys(options.target.tabs).every((id) => mapped.has(id));
    latest = { actual, mapping: seed, complete, fingerprint: currentFingerprint };
    options.sampled?.(latest);

    const stableFor = time - changedAt;
    const elapsed = time - started;
    const quiet = time >= options.quietAt();
    const settled = complete
      ? stableFor >= RESTORE_COMPLETE_STABLE_MS
      : elapsed >= RESTORE_PARTIAL_GRACE_MS && stableFor >= RESTORE_PARTIAL_STABLE_MS;
    if (
      (actual.length > 0 && quiet && settled) ||
      elapsed >= (options.maximumWait ?? RESTORE_MAX_WAIT_MS)
    )
      return latest;
    await wait(RESTORE_POLL_MS);
  }
}
