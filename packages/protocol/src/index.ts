// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  assert,
  canonical,
  classifyTab,
  id,
  integer,
  isSyncable,
  isWeb,
  LIMITS,
  record,
  type TabKind,
  text,
} from "@relay/shared";
import {
  applyGroupChange,
  type GroupChange,
  groupColor,
  groupTabs,
  groupTitle,
  type LogicalGroup,
  normalizeGroups,
  parseGroup,
  validateGroups,
} from "./groups";

export {
  GROUP_COLORS,
  type GroupColor,
  groupStructure,
  type LogicalGroup,
  normalizeGroups,
  parseGroup,
} from "./groups";
export interface Device {
  id: string;
  auth: string;
  exchange: string;
}
export interface Cipher {
  nonce: string;
  ciphertext: string;
}
export interface KeyBox extends Cipher {
  ephemeral: string;
}
export interface Recovery {
  auth: string;
  exchange: string;
  blob: Cipher;
}
export interface ControlBody {
  version: 1;
  account: string;
  generation: number;
  previous: string;
  epoch: number;
  actor: string;
  members: Device[];
  recovery: Recovery;
  boxes: Record<string, KeyBox>;
}
export interface Control extends ControlBody {
  signature: string;
}
export interface Header {
  version: 1;
  account: string;
  epoch: number;
  sender: string;
  sequence: number;
  base: number;
  type: "operation" | "snapshot";
}
export interface Envelope {
  header: Header;
  cipher: Cipher;
  signature: string;
}
export interface Challenge {
  version: 1;
  account: string;
  device: string;
  purpose: string;
  nonce: string;
  issued: number;
  expires: number;
  digest: string;
}
export const CHALLENGE_LIFETIME_MS = 30_000;
export const CLOCK_SKEW_MS = 120_000;
export interface Proof {
  challenge: Challenge;
  signature: string;
}
export interface PairStart {
  id: string;
  device: Device;
  commitment: string;
  expires: number;
}
export interface PairOffer {
  device: Device;
  commitment: string;
}
export interface Reveal {
  ephemeral: string;
  random: string;
}
export interface PairRequest extends PairStart {
  offer?: PairOffer;
  requesterReveal?: Reveal;
  approverReveal?: Reveal;
  status: "pending" | "approved" | "denied";
  control?: Control;
}
export interface PairTranscript {
  version: 1;
  account: string;
  request: PairStart;
  offer: PairOffer;
  requesterReveal: Reveal;
  approverReveal: Reveal;
}
export function pairStart(pair: PairStart): PairStart {
  return {
    id: id(pair.id),
    device: parseDevice(pair.device),
    commitment: text(pair.commitment, 64),
    expires: integer(pair.expires),
  };
}
export function parsePair(value: unknown): PairRequest {
  const p = record(value);
  assert(p.status === "pending" || p.status === "approved" || p.status === "denied");
  const result: PairRequest = { ...pairStart(p as unknown as PairStart), status: p.status };
  if (p.offer) {
    const o = record(p.offer);
    result.offer = { device: parseDevice(o.device), commitment: text(o.commitment, 64) };
  }
  for (const key of ["requesterReveal", "approverReveal"] as const)
    if (p[key]) {
      const r = record(p[key]);
      result[key] = { ephemeral: text(r.ephemeral, 256), random: text(r.random, 64) };
    }
  if (p.control) result.control = parseControl(p.control);
  return result;
}
export interface LogicalWindow {
  id: string;
  order: number;
  changed: number;
}
export interface LogicalTab {
  id: string;
  window: string;
  kind: TabKind;
  url?: string;
  pinned: boolean;
  index: number;
  source: string;
  changed: number;
  writer?: string;
}
export interface Workspace {
  version: 1 | 2;
  id: string;
  revision: number;
  windows: Record<string, LogicalWindow>;
  tabs: Record<string, LogicalTab>;
  groups: Record<string, LogicalGroup>;
  names: Record<string, string>;
  sequences: Record<string, number>;
}
export type Change =
  | GroupChange
  | { type: "window-create"; id: string; order: number }
  | { type: "window-delete"; id: string }
  | { type: "tab-create"; tab: LogicalTab }
  | { type: "tab-delete"; id: string }
  | { type: "tab-navigate"; id: string; kind: TabKind; url?: string; source: string }
  | { type: "tab-move"; id: string; window: string; index: number }
  | { type: "tab-pin"; id: string; pinned: boolean }
  | { type: "device-name"; id: string; name: string };
export interface Operation {
  id: string;
  base: number;
  sender: string;
  sequence: number;
  changes: Change[];
}
export interface OperationRow {
  revision: number;
  envelope: Envelope;
}
export interface SyncReply {
  // Pagination-capable peers receive either a control page or a workspace
  // page. Legacy complete replies omit `kind` and retain control + chain.
  kind?: "control" | "workspace";
  control?: Control;
  chain: Control[];
  generation?: number;
  fromGeneration?: number;
  nextGeneration?: number;
  snapshot?: Envelope;
  operations?: OperationRow[];
  // `from` is the revision represented by the snapshot (if supplied), or the
  // requested revision. Operations then cover the contiguous range through
  // `next`. `revision` remains the server's latest revision for this reply.
  from?: number;
  next?: number;
  more?: boolean;
  revision?: number;
  sequence?: number;
  pending?: PairRequest[];
  presence?: Record<string, { online: boolean; lastSeen: number }>;
}
export function emptyWorkspace(): Workspace {
  return {
    version: 1,
    id: crypto.randomUUID(),
    revision: 0,
    windows: {},
    tabs: {},
    groups: {},
    names: {},
    sequences: {},
  };
}
export function tabsIn(workspace: Workspace, window: string): LogicalTab[] {
  return Object.values(workspace.tabs)
    .filter((t) => t.window === window)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || a.index - b.index || a.id.localeCompare(b.id),
    );
}
export function applyOperation(
  state: Workspace,
  operation: Operation,
  revision: number,
): Workspace {
  if (revision <= state.revision) return state;
  if (operation.sequence <= (state.sequences[operation.sender] ?? 0)) return { ...state, revision };
  const next = structuredClone(state);
  next.groups ??= {};
  next.sequences[operation.sender] = operation.sequence;
  for (const change of operation.changes) {
    if (
      change.type === "group-create" ||
      change.type === "group-delete" ||
      change.type === "group-title" ||
      change.type === "group-color" ||
      change.type === "group-members"
    ) {
      applyGroupChange(next, change, revision, operation.sender, operation.base);
      continue;
    }
    const tab = "id" in change ? next.tabs[change.id] : undefined;
    switch (change.type) {
      case "window-create":
        if (!next.windows[change.id] && Object.keys(next.windows).length < LIMITS.windows)
          next.windows[change.id] = { id: change.id, order: change.order, changed: revision };
        break;
      case "window-delete": {
        const window = next.windows[change.id];
        const children = Object.values(next.tabs).filter((t) => t.window === change.id);
        // One close transaction owns its children. Preserve a concurrent peer edit.
        if (
          window &&
          !children.some((t) => t.changed > operation.base && t.writer !== operation.sender)
        ) {
          for (const child of children) delete next.tabs[child.id];
          for (const group of Object.values(next.groups))
            if (group.window === change.id) delete next.groups[group.id];
          delete next.windows[change.id];
        }
        break;
      }
      case "tab-create":
        if (
          !next.tabs[change.tab.id] &&
          isSyncable(change.tab.kind) &&
          next.windows[change.tab.window] &&
          Object.keys(next.tabs).length < LIMITS.tabs
        )
          next.tabs[change.tab.id] = { ...change.tab, changed: revision, writer: operation.sender };
        break;
      case "tab-delete":
        if (tab && (tab.changed <= operation.base || tab.writer === operation.sender))
          delete next.tabs[change.id];
        break;
      case "tab-navigate":
        if (tab) {
          if (!isSyncable(change.kind)) {
            delete next.tabs[change.id];
            break;
          }
          tab.kind = change.kind;
          delete tab.url;
          if (change.url) tab.url = change.url;
          tab.source = change.source;
          tab.changed = revision;
          tab.writer = operation.sender;
        }
        break;
      case "tab-move":
        if (tab && next.windows[change.window]) {
          tab.window = change.window;
          tab.index = change.index;
          tab.changed = revision;
          tab.writer = operation.sender;
        }
        break;
      case "tab-pin":
        if (tab) {
          tab.pinned = change.pinned;
          tab.changed = revision;
          tab.writer = operation.sender;
        }
        break;
      case "device-name":
        next.names[change.id] = change.name;
        break;
    }
  }
  normalizeGroups(next);
  next.revision = revision;
  return next;
}
export function parseDevice(value: unknown): Device {
  const v = record(value);
  return { id: id(v.id), auth: text(v.auth, 256), exchange: text(v.exchange, 256) };
}
export function parseCipher(value: unknown): Cipher {
  const v = record(value);
  const nonce = text(v.nonce, 16);
  assert(/^[A-Za-z0-9+/]{16}$/.test(nonce));
  const ciphertext = text(v.ciphertext, LIMITS.message);
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext));
  return { nonce, ciphertext };
}
export function parseControl(value: unknown): Control {
  const v = record(value);
  assert(v.version === 1);
  const members = v.members;
  assert(Array.isArray(members) && members.length > 0 && members.length <= LIMITS.devices);
  const devices = members.map(parseDevice);
  assert(new Set(devices.map((d) => d.id)).size === devices.length);
  const r = record(v.recovery);
  const boxes: Record<string, KeyBox> = {};
  for (const [key, box] of Object.entries(record(v.boxes))) {
    const b = record(box);
    boxes[id(key)] = { ...parseCipher(box), ephemeral: text(b.ephemeral, 256) };
  }
  assert(
    Object.keys(boxes).length === devices.length + 1 &&
      boxes.recovery &&
      devices.every((d) => boxes[d.id]),
  );
  return {
    version: 1,
    account: text(v.account, 64),
    generation: integer(v.generation),
    previous: text(v.previous, 128),
    epoch: integer(v.epoch, 1),
    actor: id(v.actor),
    members: devices,
    recovery: {
      auth: text(r.auth, 256),
      exchange: text(r.exchange, 256),
      blob: parseCipher(r.blob),
    },
    boxes,
    signature: text(v.signature, 256),
  };
}
export function parseEnvelope(value: unknown): Envelope {
  const v = record(value);
  const h = record(v.header);
  assert(h.version === 1 && (h.type === "operation" || h.type === "snapshot"));
  return {
    header: {
      version: 1,
      account: text(h.account, 64),
      epoch: integer(h.epoch, 1),
      sender: id(h.sender),
      sequence: integer(h.sequence),
      base: integer(h.base),
      type: h.type,
    },
    cipher: parseCipher(v.cipher),
    signature: text(v.signature, 256),
  };
}
function navigation(value: Record<string, unknown>): { kind: TabKind; url?: string } {
  const kinds: TabKind[] = [
    "web",
    "remote-pdf-as-web",
    "newtab",
    "local-file",
    "browser-internal",
    "extension-page",
    "devtools",
    "blob",
    "data",
    "other-protected",
  ];
  assert(kinds.includes(value.kind as TabKind));
  const kind = value.kind as TabKind;
  if (!isWeb(kind)) {
    assert(value.url === undefined);
    return { kind };
  }
  const url = text(value.url, 32768);
  assert(classifyTab(url)?.kind === kind);
  return { kind, url };
}
export function parseTab(value: unknown): LogicalTab {
  const v = record(value);
  assert(typeof v.pinned === "boolean");
  return {
    id: id(v.id),
    window: id(v.window),
    ...navigation(v),
    pinned: v.pinned,
    index: integer(v.index),
    source: id(v.source),
    changed: integer(v.changed),
    ...(v.writer === undefined ? {} : { writer: id(v.writer) }),
  };
}
export function parseOperation(value: unknown): Operation {
  const v = record(value);
  assert(Array.isArray(v.changes) && v.changes.length <= LIMITS.tabs * 4);
  const changes: Change[] = v.changes.map((raw) => {
    const c = record(raw);
    if (c.type === "tab-create") return { type: c.type, tab: parseTab(c.tab) };
    if (c.type === "group-create") return { type: c.type, group: parseGroup(c.group) };
    const key = id(c.id);
    switch (c.type) {
      case "window-create":
        return { type: c.type, id: key, order: integer(c.order) };
      case "window-delete":
      case "tab-delete":
      case "group-delete":
        return { type: c.type, id: key };
      case "group-title":
        return { type: c.type, id: key, title: groupTitle(c.title) };
      case "group-color":
        return { type: c.type, id: key, color: groupColor(c.color) };
      case "group-members":
        return { type: c.type, id: key, window: id(c.window), tabs: groupTabs(c.tabs) };
      case "tab-navigate":
        return { type: c.type, id: key, ...navigation(c), source: id(c.source) };
      case "tab-move":
        return { type: c.type, id: key, window: id(c.window), index: integer(c.index) };
      case "tab-pin":
        assert(typeof c.pinned === "boolean");
        return { type: c.type, id: key, pinned: c.pinned };
      case "device-name":
        return { type: c.type, id: key, name: text(c.name, 80) };
      default:
        throw new Error("Unsupported operation");
    }
  });
  return {
    id: id(v.id),
    base: integer(v.base),
    sender: id(v.sender),
    sequence: integer(v.sequence, 1),
    changes,
  };
}
export function parseWorkspace(value: unknown): Workspace {
  const v = record(value);
  assert(
    v.version === 1 || v.version === 2,
    "Unsupported workspace schema. Update Relay on all devices.",
  );
  const windows: Workspace["windows"] = {};
  const tabs: Workspace["tabs"] = {};
  const groups: Workspace["groups"] = {};
  assert(v.version !== 2 || v.groups !== undefined, "Schema 2 requires the groups collection.");
  for (const [key, raw] of Object.entries(record(v.groups ?? {})))
    groups[id(key)] = parseGroup(raw);
  const names: Record<string, string> = {};
  const sequences: Record<string, number> = {};
  for (const [key, sequence] of Object.entries(record(v.sequences)))
    sequences[id(key)] = integer(sequence);
  assert(Object.keys(sequences).length <= LIMITS.control);
  for (const [key, raw] of Object.entries(record(v.windows))) {
    const w = record(raw);
    assert(key === w.id);
    windows[id(key)] = { id: key, order: integer(w.order), changed: integer(w.changed) };
  }
  for (const [key, raw] of Object.entries(record(v.tabs))) {
    const tab = parseTab(raw);
    assert(key === tab.id && windows[tab.window]);
    tabs[key] = tab;
  }
  for (const [key, name] of Object.entries(record(v.names))) names[id(key)] = text(name, 80);
  assert(
    Object.keys(windows).length <= LIMITS.windows &&
      Object.keys(tabs).length <= LIMITS.tabs &&
      Object.keys(names).length <= 1000,
  );
  const workspace: Workspace = {
    version: v.version,
    id: id(v.id),
    revision: integer(v.revision),
    windows,
    tabs,
    groups,
    names,
    sequences,
  };
  validateGroups(workspace);
  return replicatedWorkspace(workspace);
}
// Upgrade the prior placeholder policy without ever deleting a real local protected page.
export function replicatedWorkspace(workspace: Workspace): Workspace {
  const next = structuredClone(workspace);
  const removedWindows = new Set<string>();
  for (const tab of Object.values(next.tabs))
    if (!isSyncable(tab.kind)) {
      removedWindows.add(tab.window);
      delete next.tabs[tab.id];
    }
  for (const window of removedWindows)
    if (!Object.values(next.tabs).some((t) => t.window === window)) delete next.windows[window];
  normalizeGroups(next);
  return next;
}
export function controlBody(control: Control): ControlBody {
  const { signature: _, ...body } = control;
  return body;
}
export const sameDevice = (a: Device, b: Device) => canonical(a) === canonical(b);
