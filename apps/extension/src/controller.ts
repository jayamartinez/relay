// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountHandle,
  accountNumber,
  base64,
  checkControl,
  controlHash,
  decryptEnvelope,
  encryptEnvelope,
  ephemeral,
  type Identity,
  identity,
  makeControl,
  makeRecovery,
  pairing,
  parseRecovery,
  randomKey,
  recoverIdentity,
  recoveryCode,
  sign,
  unbase64,
  unwrapRoot,
  verify,
  wrapRoot,
} from "@relay/crypto";
import {
  applyOperation,
  type Change,
  type Control,
  controlBody,
  type Device,
  type Envelope,
  emptyWorkspace,
  normalizeGroups,
  type Operation,
  type PairRequest,
  type PairStart,
  type PairTranscript,
  pairStart,
  parseControl,
  parseEnvelope,
  parseOperation,
  parsePair,
  parseWorkspace,
  type Recovery,
  type Reveal,
  type SyncReply,
  sameDevice,
  type Workspace,
} from "@relay/protocol";
import {
  assert,
  canonical,
  canonicalAccount,
  LIMITS,
  record,
  serverOrigin,
  text,
} from "@relay/shared";
import { Api, ApiError } from "./api";
import {
  browserWindows,
  capture,
  ownOrigin,
  reconcile,
  sessionId,
  workspaceStats,
} from "./browser";
import { BrowserEvents, type Lifecycle } from "./browser-events";
import { diffWorkspace, type Mapping, navigationCircuit } from "./browser-model";
import { diagnosticDevice, diagnosticSnapshot, trace } from "./diagnostics";
import { groupsAvailable, groupsEnabled, requireGroupSupport } from "./group-browser";
import { committedNavigation, expectNavigation, remoteNavigationEvent } from "./navigation";
import {
  defaultSyncPreferences,
  loadSyncPreferences,
  type SyncPreferencesV1,
  saveSyncPreferences,
} from "./preferences";
import * as vault from "./vault";
import { initialMerge, restoreMapping } from "./workspace-lifecycle";

declare const __DEV__: boolean;
declare const __OFFICIAL_ORIGIN__: string;
interface QueueEntry {
  sequence: number;
  operation: Operation;
}
interface EphemeralState {
  reveal: Reveal;
  commitment: string;
  request?: PairStart;
}
interface Local {
  version: 1;
  phase: "draft" | "pending" | "merge" | "active";
  server: string;
  account: string;
  handle: string;
  device: Device;
  name: string;
  root?: string;
  control?: Control;
  canonical: Workspace;
  queue: QueueEntry[];
  nextSequence: number;
  mapping: Mapping;
  paused: boolean;
  intent?: Workspace;
  recoveryDisplay?: string;
  initialSnapshot?: Envelope;
  initialMergeDone?: boolean;
  request?: PairRequest;
  pairSecrets: Record<string, EphemeralState>;
  approvals: PairRequest[];
  presence: SyncReply["presence"];
  lastSynced: number;
  diagnostics: { operations: number; reconnects: number; snapshotBytes: number };
}
export class Controller {
  readonly events = new BrowserEvents();
  lifecycle: Lifecycle = "UNINITIALIZED";
  private remoteWindowCloses = new Map<number, number>();
  private local?: Local;
  private signing?: CryptoKey;
  private exchange?: CryptoKey;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private lastSocketMessage = 0;
  private network = "Not connected";
  private error = "";
  private halted = false;
  private loaded = false;
  private loadFailed = false;
  private lastCheckpoint = 0;
  private preferences: SyncPreferencesV1 = defaultSyncPreferences();
  private api(): Api {
    const s = this.require();
    return new Api(s.server, s.handle);
  }
  private require(): Local {
    assert(this.local, "Set up Relay first.");
    return this.local;
  }
  private key(): CryptoKey {
    assert(this.signing, "Device signing key is missing.");
    return this.signing;
  }
  private root(): Uint8Array<ArrayBuffer> {
    const root = this.require().root;
    assert(root, "Workspace key is unavailable.");
    return unbase64(root);
  }
  private persist() {
    return vault.saveState(this.require());
  }
  private auth<T>(action: string, payload: unknown) {
    return this.api().authenticated<T>(action, payload, this.require().device.id, this.key());
  }
  // All public entry points run through background.ts's serial task queue.
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    this.lifecycle = "LOADING_LOCAL_STATE";
    try {
      this.preferences = await loadSyncPreferences();
      this.local = await vault.loadState<Local>();
      if (!this.local) return;
      assert(this.local.version === 1, "Unsupported local-state version.");
      this.signing = await vault.read<CryptoKey>("signing");
      this.exchange = await vault.read<CryptoKey>("exchange");
      assert(
        this.signing && this.exchange,
        "Local device keys are missing. Data has not been reset.",
      );
      this.local.canonical = parseWorkspace(this.local.canonical);
      this.local.mapping.observed = parseWorkspace(this.local.mapping.observed);
      diagnosticDevice(this.local.device.id);
      requireGroupSupport(this.local.canonical);
      if (this.local.control) this.local.control = parseControl(this.local.control);
      if (this.local.phase === "active") {
        await this.hydrate();
        if (!this.local.paused) await this.connect();
      }
    } catch (error) {
      if (!this.local) this.loadFailed = true;
      this.failure(error);
    }
  }
  private async quiet() {
    // A one-shot event quiet barrier, not periodic workspace scanning.
    let delay = Math.max(200, this.events.quietAt - Date.now());
    while (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = this.events.quietAt - Date.now();
    }
  }
  private async stopped() {
    this.lifecycle = "STOPPED";
    this.events.clear();
    this.disconnect();
    this.network = "Offline";
    await chrome.alarms.clear("relay-reconnect");
    if (this.local) await this.persist();
    trace("USER", "BROWSER_SHUTDOWN", "SUPPRESS");
  }
  private async hydrate() {
    const s = this.require();
    this.lifecycle = "FETCHING_CANONICAL_STATE";
    if (!(await browserWindows()).length) {
      await this.stopped();
      return;
    }
    if (!s.paused) await this.pull();
    await this.quiet();
    const actual = await browserWindows();
    if (!actual.length) {
      await this.stopped();
      return;
    }
    this.lifecycle = "RECONCILING";
    const restored = restoreMapping(
      actual,
      s.mapping,
      this.projected(),
      await sessionId(),
      s.device.id,
      ownOrigin(),
    );
    s.mapping = restored.mapping;
    await this.enqueue(restored.changes, "STARTUP");
    s.intent = this.projected();
    await this.applyBrowser(s.intent);
    if (this.events.closing) {
      this.lifecycle = "LIVE";
      return;
    }
    this.events.clear(); // Reconciliation observed the final browser state, including startup events.
    this.lifecycle = "LIVE";
    await this.persist();
  }
  navigationEvent(local: number, url: string, complete: boolean) {
    if (this.local && remoteNavigationEvent(this.local.mapping, local, url, complete)) {
      // Still schedule one settled observation, never an immediate operation per callback.
      this.events.navigation(local, url, complete);
      return;
    }
    this.events.navigation(local, url, complete);
  }
  navigationCommitted(local: number, url: string, transition: string, qualifiers: string[]) {
    if (this.local) committedNavigation(this.local.mapping, local, url, transition, qualifiers);
    this.events.committed(local, url, transition, qualifiers);
  }
  windowRemoved(local: number) {
    if ((this.remoteWindowCloses.get(local) ?? 0) > Date.now()) {
      trace("REMOTE", "WINDOW_DELETE", "SUPPRESS");
      return;
    }
    this.events.windowRemoved(local);
  }
  tabRemoved(local: number, window: number, isWindowClosing: boolean) {
    if (isWindowClosing) {
      this.windowRemoved(window);
      return;
    }
    this.events.removed(local, window, false);
  }
  failure(error: unknown) {
    this.error = error instanceof Error ? error.message : "Relay could not complete this action.";
    if (
      error instanceof ApiError &&
      (error.status === 0 || error.status === 429 || error.status >= 500)
    ) {
      this.network = "Offline";
      this.disconnect();
      this.scheduleReconnect();
    } else if (
      error instanceof ApiError &&
      (error.status === 409 || error.status === 410 || error.status === 404)
    ) {
      // Conflicts/enrollment expiry are actionable, not evidence of corrupt ciphertext.
    } else {
      this.halted = true;
      this.network = "Needs attention";
      this.disconnect();
    }
  }
  private async newLocal(account: string, server: string, name: string): Promise<Local> {
    assert(
      !this.loadFailed,
      "Local data could not be decrypted. It has not been overwritten. Restore this browser profile from backup or use a separate profile.",
    );
    assert(!this.local, "This profile already has Relay data.");
    account = canonicalAccount(account);
    server = serverOrigin(server, __DEV__);
    name = text(name.trim(), 80);
    this.halted = false;
    const keys = await identity();
    this.signing = keys.signing;
    this.exchange = keys.exchange;
    await vault.write("signing", keys.signing);
    await vault.write("exchange", keys.exchange);
    const workspace = emptyWorkspace();
    this.local = {
      version: 1,
      phase: "draft",
      server: serverOrigin(server, __DEV__),
      account: canonicalAccount(account),
      handle: await accountHandle(account),
      device: keys.device,
      name: text(name.trim(), 80),
      canonical: workspace,
      queue: [],
      nextSequence: 1,
      mapping: { session: "", tabs: {}, windows: {}, observed: emptyWorkspace(), expected: [] },
      paused: false,
      pairSecrets: {},
      approvals: [],
      presence: {},
      lastSynced: 0,
      diagnostics: { operations: 0, reconnects: 0, snapshotBytes: 0 },
    };
    this.local.mapping.observed.id = workspace.id;
    diagnosticDevice(keys.device.id);
    await this.persist();
    return this.local;
  }
  async create(server: string, name: string) {
    const s = await this.newLocal(accountNumber(), server, name);
    const root = randomKey();
    const secret = randomKey();
    s.root = base64(root);
    s.recoveryDisplay = recoveryCode(secret);
    const recovery = await makeRecovery(secret, s.handle);
    secret.fill(0);
    const boxes = {
      [s.device.id]: await wrapRoot(root, s.device.exchange, s.handle, 1, s.device.id),
      recovery: await wrapRoot(root, recovery.exchange, s.handle, 1, "recovery"),
    };
    s.control = await makeControl(
      {
        version: 1,
        account: s.handle,
        generation: 0,
        previous: "genesis",
        epoch: 1,
        actor: s.device.id,
        members: [s.device],
        recovery,
        boxes,
      },
      this.key(),
    );
    await this.persist();
    return this.status();
  }
  private async envelope(
    type: "operation" | "snapshot",
    sequence: number,
    base: number,
    value: unknown,
    root = this.root(),
    control = this.require().control,
  ): Promise<Envelope> {
    const s = this.require();
    assert(control);
    return encryptEnvelope(
      root,
      this.key(),
      {
        version: 1,
        account: s.handle,
        epoch: control.epoch,
        sender: s.device.id,
        type,
        sequence,
        base,
      },
      value,
    );
  }
  async start() {
    const s = this.require();
    assert(s.phase === "draft" && s.control && s.root, "Account setup is incomplete.");
    if (!s.initialSnapshot) {
      const initial = initialMerge(
        await browserWindows(),
        s.mapping,
        emptyWorkspace(),
        await sessionId(),
        s.device.id,
        ownOrigin(),
      );
      s.mapping = initial.mapping;
      // First account seed and later captures both omit protected/local-only content.
      s.canonical = { ...s.mapping.observed, revision: 0, names: { [s.device.id]: s.name } };
      for (const [key, tab] of Object.entries(s.canonical.tabs))
        if (!["web", "remote-pdf-as-web", "newtab"].includes(tab.kind)) {
          delete s.canonical.tabs[key];
          for (const [local, id] of Object.entries(s.mapping.tabs))
            if (id === key) delete s.mapping.tabs[local];
        }
      for (const [key] of Object.entries(s.canonical.windows))
        if (!Object.values(s.canonical.tabs).some((t) => t.window === key))
          delete s.canonical.windows[key];
      normalizeGroups(s.canonical);
      s.mapping.observed = structuredClone(s.canonical);
      s.initialSnapshot = await this.envelope("snapshot", 0, 0, s.canonical);
      await this.persist();
    }
    await this.api().post("create", { control: s.control, snapshot: s.initialSnapshot });
    s.phase = "active";
    this.lifecycle = "LIVE";
    this.events.clear();
    delete s.recoveryDisplay;
    delete s.initialSnapshot;
    await this.persist();
    await this.captureLocal();
    await this.connect();
    return this.status();
  }
  async join(server: string, account: string, name: string) {
    const normalizedServer = serverOrigin(server, __DEV__);
    const normalizedAccount = canonicalAccount(account);
    const s = this.local ?? (await this.newLocal(normalizedAccount, normalizedServer, name));
    assert(
      s.phase === "draft" && s.account === normalizedAccount && s.server === normalizedServer,
      "Cancel the current Relay setup before using a different account or server.",
    );
    this.halted = false;
    this.error = "";
    const pair = await ephemeral();
    const request: PairStart = {
      id: crypto.randomUUID(),
      device: s.device,
      commitment: pair.commitment,
      expires: Date.now() + 590_000,
    };
    const response = await this.api().post<unknown>("pair-start", {
      ...request,
      signature: await sign(this.key(), {
        version: 1,
        account: s.handle,
        type: "pair-start",
        ...request,
      }),
    });
    assert(record(response).ok === true, "Relay did not create the device request.");
    // Only a confirmed, persisted request may enter the polling state. A failed
    // pair-start stays on the request screen and cannot produce false expirations.
    s.pairSecrets[request.id] = { reveal: pair.reveal, commitment: pair.commitment };
    await vault.write(`ephemeral:${request.id}`, pair.privateKey);
    s.request = { ...request, status: "pending" };
    s.phase = "pending";
    await this.persist();
    return this.status();
  }
  private transcript(pair: PairRequest): PairTranscript {
    assert(
      pair.offer && pair.requesterReveal && pair.approverReveal,
      "Waiting for the other device.",
    );
    const { id, device, commitment, expires } = pair;
    return {
      version: 1,
      account: this.require().handle,
      request: { id, device, commitment, expires },
      offer: pair.offer,
      requesterReveal: pair.requesterReveal,
      approverReveal: pair.approverReveal,
    };
  }
  private async pairSas(pair: PairRequest, role: "requester" | "approver"): Promise<string> {
    const key = await vault.read<CryptoKey>(`ephemeral:${pair.id}`);
    assert(key, "Pairing keys are unavailable. Start pairing again.");
    return (await pairing(key, role, this.transcript(pair))).sas;
  }
  async pollPair() {
    const s = this.require();
    if (s.phase !== "pending" || !s.request) return;
    if (s.request.expires <= Date.now()) return;
    const payload = {
      version: 1,
      account: s.handle,
      action: "pair-read",
      id: s.request.id,
      nonce: crypto.randomUUID(),
      expires: Date.now() + 25_000,
    };
    const pair = parsePair(
      await this.api().post<unknown>("pair-read", {
        ...payload,
        signature: await sign(this.key(), payload),
      }),
    );
    assert(
      canonical(pairStart(pair)) === canonical(pairStart(s.request)),
      "Pairing request changed.",
    );
    if (s.request.offer)
      assert(canonical(pair.offer) === canonical(s.request.offer), "Pairing offer changed.");
    s.request = pair;
    if (pair.offer && !pair.requesterReveal && pair.status === "pending") {
      const reveal = s.pairSecrets[pair.id]?.reveal;
      assert(reveal);
      const signed = {
        version: 1,
        account: s.handle,
        action: "pair-reveal",
        id: pair.id,
        nonce: crypto.randomUUID(),
        expires: Date.now() + 25_000,
        reveal,
      };
      s.request = await this.api().post<PairRequest>("pair-reveal", {
        ...signed,
        signature: await sign(this.key(), signed),
      });
    }
    await this.persist();
  }
  async review(requestId: string) {
    const s = this.require();
    const pending = s.approvals.find((p) => p.id === requestId);
    assert(pending && !pending.offer, "Request is no longer available.");
    const pair = await ephemeral();
    s.pairSecrets[requestId] = {
      reveal: pair.reveal,
      commitment: pair.commitment,
      request: pairStart(pending),
    };
    await vault.write(`ephemeral:${requestId}`, pair.privateKey);
    await this.persist();
    await this.auth("pair-offer", { id: requestId, commitment: pair.commitment });
    await this.pull();
    return this.status();
  }
  async approve(requestId: string, code: string) {
    const s = this.require();
    const pair = s.approvals.find((p) => p.id === requestId);
    assert(pair && pair.offer?.device.id === s.device.id && s.control);
    assert(code === (await this.pairSas(pair, "approver")), "Verification codes do not match.");
    const control = await this.addMember(pair.device, this.key(), s.device.id);
    await this.auth("pair-approve", { id: requestId, control });
    await this.pull();
    return this.status();
  }
  async deny(requestId: string) {
    await this.auth("pair-deny", { id: requestId });
    await this.pull();
    return this.status();
  }
  private async addMember(device: Device, key: CryptoKey, actor: string): Promise<Control> {
    const s = this.require();
    const previous = s.control;
    assert(previous && previous.members.length < LIMITS.devices);
    return makeControl(
      {
        ...controlBody(previous),
        generation: previous.generation + 1,
        previous: await controlHash(previous),
        actor,
        members: [...previous.members, device],
        boxes: {
          ...previous.boxes,
          [device.id]: await wrapRoot(
            this.root(),
            device.exchange,
            s.handle,
            previous.epoch,
            device.id,
          ),
        },
      },
      key,
    );
  }
  async finishPair(code: string) {
    const s = this.require();
    await this.pollPair();
    const pair = s.request;
    assert(pair?.status === "approved" && pair.control && pair.offer);
    assert(code === (await this.pairSas(pair, "requester")), "Verification codes do not match.");
    const control = parseControl(pair.control);
    assert(
      control.account === s.handle &&
        control.actor === pair.offer.device.id &&
        control.members.some((d) => sameDevice(d, s.device)) &&
        (await verify(pair.offer.device.auth, controlBody(control), control.signature)),
      "Invalid pairing authorization.",
    );
    s.control = control;
    const box = control.boxes[s.device.id];
    assert(this.exchange && box);
    s.root = base64(await unwrapRoot(box, this.exchange, s.handle, control.epoch, s.device.id));
    await this.pull(true);
    s.phase = "merge";
    this.halted = false;
    delete s.request;
    await this.clearPairSecrets();
    await this.persist();
    return this.status();
  }
  async recover(server: string, account: string, name: string, code: string) {
    const s = this.local ?? (await this.newLocal(account, server, name));
    assert(s.phase !== "active", "This device is already authorized.");
    assert(
      s.account === canonicalAccount(account) && s.server === serverOrigin(server, __DEV__),
      "Recovery must use this account and server.",
    );
    this.halted = false;
    this.error = "";
    const info = await this.api().post<{ recovery: Recovery; chain: Control[] }>(
      "recover-info",
      {},
    );
    const keys = await recoverIdentity(parseRecovery(code), s.handle, info.recovery);
    assert(
      Array.isArray(info.chain) && info.chain.length > 0 && info.chain.length <= LIMITS.control,
    );
    let previous: Control | undefined;
    for (const raw of info.chain) {
      const c = parseControl(raw);
      assert(c.account === s.handle && canonical(c.recovery) === canonical(info.recovery));
      await checkControl(c, previous);
      previous = c;
    }
    assert(previous);
    s.control = previous;
    const box = previous.boxes.recovery;
    assert(box);
    s.root = base64(await unwrapRoot(box, keys.exchange, s.handle, previous.epoch, "recovery"));
    const alreadyAuthorized = previous.members.find((d) => d.id === s.device.id);
    if (alreadyAuthorized) assert(sameDevice(alreadyAuthorized, s.device));
    else {
      const control = await this.addMember(s.device, keys.signing, "recovery");
      await this.api().authenticated("recover-join", { control }, "recovery", keys.signing);
      s.control = control;
    }
    await this.pull(true);
    s.phase = "merge";
    this.halted = false;
    delete s.request;
    await this.clearPairSecrets();
    await this.persist();
    return this.status();
  }
  async merge() {
    const s = this.require();
    assert(s.phase === "merge");
    this.lifecycle = "RECONCILING";
    if (!s.initialMergeDone) {
      const imported = initialMerge(
        await browserWindows(),
        s.mapping,
        s.canonical,
        await sessionId(),
        s.device.id,
        ownOrigin(),
      );
      s.mapping = imported.mapping;
      s.initialMergeDone = true;
      await this.enqueue(
        [...imported.changes, { type: "device-name", id: s.device.id, name: s.name }],
        "STARTUP",
      );
    }
    s.phase = "active";
    s.intent = this.projected();
    await this.applyBrowser(this.projected());
    if (!this.events.closing) this.events.clear();
    this.lifecycle = "LIVE";
    await this.persist();
    await this.connect();
    return this.status();
  }
  private async clearPairSecrets() {
    const s = this.require();
    for (const requestId of Object.keys(s.pairSecrets))
      await vault.remove(`ephemeral:${requestId}`);
    s.pairSecrets = {};
  }
  private projected(): Workspace {
    const s = this.require();
    let state = s.canonical;
    for (const entry of s.queue)
      state = applyOperation(
        state,
        { ...entry.operation, base: state.revision },
        state.revision + 1,
      );
    state = structuredClone(state);
    // Projection choices remain local; encrypted canonical workspace state is never rewritten.
    if (!this.preferences.tabGroups) state.groups = {};
    if (!this.preferences.navigation || !this.preferences.pinnedTabs)
      for (const [id, tab] of Object.entries(state.tabs)) {
        const observed = s.mapping.observed.tabs[id];
        if (!observed) continue;
        if (!this.preferences.navigation) {
          tab.kind = observed.kind;
          tab.url = observed.url;
        }
        if (!this.preferences.pinnedTabs) tab.pinned = observed.pinned;
      }
    return state;
  }
  private allowedLocalChanges(changes: Change[]): Change[] {
    return changes.filter((change) => {
      if (change.type === "tab-create") return this.preferences.tabCreation;
      if (change.type === "tab-navigate") return this.preferences.navigation;
      if (change.type === "tab-pin") return this.preferences.pinnedTabs;
      if (change.type.startsWith("group-")) return this.preferences.tabGroups;
      return true;
    });
  }
  private forgetUnsyncedCreations(mapping: Mapping, changes: Change[]) {
    const ignored = changes
      .filter(
        (change): change is Extract<Change, { type: "tab-create" }> => change.type === "tab-create",
      )
      .map((change) => change.tab.id);
    if (!ignored.length) return;
    for (const [local, id] of Object.entries(mapping.tabs))
      if (ignored.includes(id)) delete mapping.tabs[local];
    for (const id of ignored) delete mapping.observed.tabs[id];
    for (const [windowId, window] of Object.entries(mapping.observed.windows))
      if (!Object.values(mapping.observed.tabs).some((tab) => tab.window === windowId)) {
        delete mapping.observed.windows[windowId];
        for (const [local, id] of Object.entries(mapping.windows))
          if (id === window.id) delete mapping.windows[local];
      }
  }
  async updatePreferences(update: Partial<Omit<SyncPreferencesV1, "schemaVersion">>) {
    const previous = this.preferences;
    this.preferences = await saveSyncPreferences(update);
    // Re-enabling groups is the one safe immediate projection: it reuses mapped tabs.
    // Navigation and pin state deliberately wait for their next normal reconciliation.
    if (
      previous.tabGroups !== this.preferences.tabGroups &&
      this.local?.phase === "active" &&
      this.lifecycle === "LIVE"
    ) {
      this.local.intent = this.projected();
      await this.applyBrowser(this.local.intent);
    }
    return this.status();
  }
  private async enqueue(changes: Change[], source: "USER" | "STARTUP" = "USER") {
    if (!changes.length) return;
    const s = this.require();
    assert(
      s.queue.length < LIMITS.queue,
      "Offline queue is full. Sync before making more changes.",
    );
    const sequence = s.nextSequence++;
    s.queue.push({
      sequence,
      operation: {
        id: crypto.randomUUID(),
        base: s.canonical.revision,
        sender: s.device.id,
        sequence,
        changes,
      },
    });
    s.diagnostics.operations++;
    const operation = s.queue.at(-1)!.operation;
    for (const change of changes) {
      if (change.type === "tab-navigate" || change.type === "tab-create") {
        const logical = change.type === "tab-create" ? change.tab.id : change.id;
        const tab = s.mapping.observed.tabs[logical];
        const local = Object.entries(s.mapping.tabs).find(([, id]) => id === logical)?.[0];
        if (tab && local)
          expectNavigation(s.mapping, tab, Number(local), undefined, operation.id, "USER");
      }
      trace(
        source,
        change.type.toUpperCase().replaceAll("-", "_"),
        "EMIT",
        change.type === "tab-create"
          ? change.tab.id
          : change.type === "group-create"
            ? change.group.id
            : change.id,
        operation.id,
      );
    }
    await this.persist();
  }
  async captureLocal() {
    const s = this.local;
    if (!s || s.phase !== "active" || this.halted || this.lifecycle !== "LIVE") return false;
    requireGroupSupport(s.canonical);
    const evidence = this.events.take();
    if (!evidence) return false;
    const result = await capture(s.mapping, s.device.id, evidence, this.projected());
    if (result.shutdown) {
      await this.stopped();
      return false;
    }
    if (this.events.closing) {
      this.events.restore(evidence);
      return false;
    }
    // A normal new tab keeps its mapping immediately. Only tabs intentionally excluded
    // by the device-local preference must be forgotten, otherwise reconciliation would
    // see the canonical create as missing and build a duplicate.
    if (!this.preferences.tabCreation) this.forgetUnsyncedCreations(result.mapping, result.changes);
    s.mapping = result.mapping;
    if (navigationCircuit(result.changes, s.mapping)) {
      s.paused = true;
      this.error =
        "Relay paused after repeated navigation reversals. Check for sign-in redirects or conflicting device edits, then resume. Local changes are saved.";
      this.disconnect();
      await chrome.alarms.clear("relay-reconnect");
    }
    await this.enqueue(this.allowedLocalChanges(result.changes));
    await this.persist();
    return result.changes.length > 0;
  }
  async browserChanged() {
    if (this.local?.phase === "active" && this.lifecycle === "STOPPED" && !this.events.closing) {
      await this.hydrate();
      if ((this.lifecycle as Lifecycle) === "LIVE") await this.connect();
      return;
    }
    const changed = await this.captureLocal();
    if (
      (changed ||
        this.local?.intent ||
        (this.local && diffWorkspace(this.local.mapping.observed, this.projected()).length > 0)) &&
      this.local &&
      !this.local.paused &&
      !this.halted &&
      this.local.phase === "active"
    )
      await this.flush();
  }
  private async applyBrowser(target: Workspace) {
    requireGroupSupport(target);
    const s = this.require();
    if (this.events.closing || this.lifecycle === "STOPPED") return;
    if (!s.intent && diffWorkspace(s.mapping.observed, target).length === 0) return;
    s.intent = target;
    for (const [local, logical] of Object.entries(s.mapping.windows))
      if (!Object.values(target.tabs).some((t) => t.window === logical))
        this.remoteWindowCloses.set(Number(local), Date.now() + 15_000);
    const previousLifecycle = this.lifecycle;
    this.lifecycle = "RECONCILING";
    await this.persist();
    try {
      s.mapping = await reconcile(
        target,
        s.mapping,
        s.device.id,
        async (mapping) => {
          s.mapping = mapping;
          await this.persist();
        },
        () => !this.events.closing,
      );
    } catch (error) {
      if (this.events.closing) return; // Keep durable intent; the close transaction decides next.
      throw error;
    } finally {
      this.lifecycle = previousLifecycle;
    }
    delete s.intent;
    await this.persist();
  }
  private async advanceChain(raw: Control[]) {
    const s = this.require();
    assert(s.control);
    let current = s.control;
    for (const item of raw) {
      const next = parseControl(item);
      if (next.generation <= current.generation) {
        if (next.generation === current.generation)
          assert(
            (await controlHash(next)) === (await controlHash(current)),
            "Server fork detected.",
          );
        continue;
      }
      await checkControl(next, current);
      current = next;
    }
    const member = current.members.find((d) => d.id === s.device.id);
    if (!member) {
      await this.wipeRevoked();
      throw new Error(
        "This device was revoked. Local Relay data was erased; browser tabs were kept.",
      );
    }
    assert(sameDevice(member, s.device));
    if (current.epoch !== s.control.epoch) {
      const box = current.boxes[s.device.id];
      assert(this.exchange && box);
      s.root = base64(await unwrapRoot(box, this.exchange, s.handle, current.epoch, s.device.id));
    }
    s.control = current;
  }
  async pull(force = false) {
    const s = this.require();
    assert(s.control);
    const reply = await this.auth<SyncReply>("sync", {
      since: s.canonical.revision,
      generation: s.control.generation,
      force: force || s.phase === "merge",
    });
    assert(
      Array.isArray(reply.chain) &&
        reply.chain.length <= LIMITS.control &&
        Array.isArray(reply.operations) &&
        reply.operations.length <= LIMITS.operations,
    );
    const oldEpoch = s.control.epoch;
    await this.advanceChain(reply.chain);
    assert(
      s.control && canonical(parseControl(reply.control)) === canonical(s.control),
      "Membership state mismatch.",
    );
    if (oldEpoch !== s.control.epoch && !reply.snapshot) {
      await this.pull(true);
      return;
    }
    let canonicalState = s.canonical;
    const decrypt = async (envelope: Envelope) => {
      const member = s.control?.members.find((d) => d.id === envelope.header.sender);
      assert(member, "Unknown workspace signer.");
      return decryptEnvelope<unknown>(
        this.root(),
        envelope,
        member,
        s.handle,
        s.control?.epoch ?? 0,
      );
    };
    if (reply.snapshot) {
      const snapshot = parseEnvelope(reply.snapshot);
      assert(
        snapshot.header.type === "snapshot" && snapshot.header.base >= s.canonical.revision,
        "Stale snapshot rejected.",
      );
      canonicalState = parseWorkspace(await decrypt(snapshot));
      assert(canonicalState.revision === snapshot.header.base);
    }
    for (const row of reply.operations) {
      assert(row.revision === canonicalState.revision + 1, "Missing workspace revision.");
      const envelope = parseEnvelope(row.envelope);
      assert(envelope.header.type === "operation");
      const operation = parseOperation(await decrypt(envelope));
      assert(
        operation.base === envelope.header.base &&
          operation.sender === envelope.header.sender &&
          operation.sequence === envelope.header.sequence,
      );
      assert(
        operation.sequence === (canonicalState.sequences[operation.sender] ?? 0) + 1,
        "Replayed or missing workspace operation rejected.",
      );
      canonicalState = applyOperation(canonicalState, operation, row.revision);
    }
    assert(canonicalState.revision === reply.revision, "Workspace revision mismatch.");
    assert(
      reply.sequence === (canonicalState.sequences[s.device.id] ?? 0),
      "Unverified journal acknowledgment rejected.",
    );
    s.canonical = canonicalState;
    s.queue = s.queue.filter((q) => q.sequence > reply.sequence);
    s.nextSequence = Math.max(s.nextSequence, reply.sequence + 1);
    assert(Array.isArray(reply.pending) && reply.pending.length <= LIMITS.pending);
    s.approvals = reply.pending.map(parsePair);
    for (const requestId of Object.keys(s.pairSecrets))
      if (requestId !== s.request?.id && !s.approvals.some((p) => p.id === requestId)) {
        delete s.pairSecrets[requestId];
        await vault.remove(`ephemeral:${requestId}`);
      }
    for (const request of s.approvals) {
      const pinned = s.pairSecrets[request.id];
      if (!pinned?.request) continue;
      assert(
        canonical(pairStart(request)) === canonical(pinned.request),
        "Pairing requester changed after commitment.",
      );
      assert(
        request.offer &&
          sameDevice(request.offer.device, s.device) &&
          request.offer.commitment === pinned.commitment,
        "Pairing approver changed after commitment.",
      );
    }
    s.presence = reply.presence;
    s.lastSynced = Date.now();
    await chrome.action.setBadgeText({
      text: s.approvals.length ? String(s.approvals.length) : "",
    });
    await this.persist();
    for (const pair of s.approvals) {
      if (pair.offer?.device.id === s.device.id && pair.requesterReveal && !pair.approverReveal) {
        const secret = s.pairSecrets[pair.id];
        if (secret) await this.auth("pair-answer", { id: pair.id, reveal: secret.reveal });
      }
    }
    if (
      s.phase === "active" &&
      !s.paused &&
      this.lifecycle === "LIVE" &&
      Date.now() >= this.events.readyAt
    )
      await this.applyBrowser(this.projected());
    this.error = "";
  }
  async flush() {
    const s = this.local;
    if (
      !s ||
      s.phase !== "active" ||
      s.paused ||
      this.halted ||
      this.lifecycle !== "LIVE" ||
      this.events.closing
    )
      return;
    await this.pull();
    for (const entry of [...s.queue]) {
      if (this.events.closing || this.lifecycle !== "LIVE") return;
      const envelope = await this.envelope(
        "operation",
        entry.sequence,
        entry.operation.base,
        entry.operation,
      );
      try {
        await this.auth("push", { envelope });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          await this.pull();
          await this.checkpoint();
          await this.auth("push", { envelope });
        } else throw error;
      }
      // Keep the journal until a signed canonical pull and server sequence acknowledge it.
      await this.pull();
    }
    if (s.canonical.revision > this.lastCheckpoint + 64) await this.checkpoint();
  }
  async checkpoint() {
    const s = this.require();
    const snapshot = await this.envelope("snapshot", 0, s.canonical.revision, s.canonical);
    try {
      await this.auth("checkpoint", { snapshot });
      this.lastCheckpoint = s.canonical.revision;
      s.diagnostics.snapshotBytes = JSON.stringify(snapshot).length;
      await this.persist();
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
    }
  }
  async rename(device: string, name: string) {
    assert(this.require().control?.members.some((d) => d.id === device));
    await this.enqueue([{ type: "device-name", id: device, name: text(name.trim(), 80) }]);
    await this.flush();
    return this.status();
  }
  async revoke(device: string) {
    const s = this.require();
    assert(device !== s.device.id && !s.paused, "Resume Relay before revoking a remote device.");
    await this.captureLocal();
    await this.flush();
    const previous = s.control;
    assert(previous && previous.members.some((d) => d.id === device));
    const root = randomKey();
    const epoch = previous.epoch + 1;
    const members = previous.members.filter((d) => d.id !== device);
    const boxes: Control["boxes"] = {};
    for (const member of members)
      boxes[member.id] = await wrapRoot(root, member.exchange, s.handle, epoch, member.id);
    boxes.recovery = await wrapRoot(root, previous.recovery.exchange, s.handle, epoch, "recovery");
    const control = await makeControl(
      {
        ...controlBody(previous),
        generation: previous.generation + 1,
        previous: await controlHash(previous),
        epoch,
        members,
        boxes,
        actor: s.device.id,
      },
      this.key(),
    );
    const snapshot = await this.envelope(
      "snapshot",
      0,
      s.canonical.revision,
      s.canonical,
      root,
      control,
    );
    await this.auth("rotate", { control, snapshot });
    s.control = control;
    s.root = base64(root);
    await this.persist();
    await this.pull();
    return this.status();
  }
  async pause(value: boolean) {
    const s = this.require();
    s.paused = value;
    await this.persist();
    if (value) {
      this.disconnect();
      await chrome.alarms.clear("relay-reconnect");
      this.network = "Paused";
    } else {
      this.halted = false;
      await this.captureLocal();
      await this.connect();
    }
    return this.status();
  }
  async retry() {
    this.halted = false;
    this.error = "";
    if (this.local?.phase === "active") await this.connect();
    return this.status();
  }
  private disconnect() {
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    this.heartbeat = undefined;
    const old = this.socket;
    this.socket = undefined;
    if (old) {
      old.onclose = null;
      old.close();
    }
  }
  private scheduleReconnect() {
    if (
      !this.local ||
      this.local.paused ||
      this.halted ||
      this.local.phase !== "active" ||
      this.lifecycle === "STOPPED"
    )
      return;
    const delay =
      Math.min(300_000, 2000 * 2 ** Math.min(this.reconnectAttempt++, 8)) *
      (0.75 + Math.random() * 0.5);
    this.reconnectTimer = setTimeout(() => this.wake(), delay);
    void chrome.alarms.create("relay-reconnect", { when: Date.now() + Math.max(30_000, delay) });
  }
  wake: () => void = () => {};
  onSocketMessage: (data: string) => void = () => {};
  async connect() {
    const s = this.local;
    if (!s || s.phase !== "active" || s.paused || this.halted) return;
    if (this.lifecycle !== "LIVE") await this.hydrate();
    if (this.lifecycle !== "LIVE" || this.events.closing) return;
    this.disconnect();
    this.network = "Connecting";
    await this.flush();
    const { ticket } = await this.auth<{ ticket: string }>("socket-ticket", {});
    const url = new URL(`${s.server}/v1/${s.handle}/socket`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    const socket = new WebSocket(url);
    this.socket = socket;
    s.diagnostics.reconnects++;
    await this.persist();
    socket.onopen = () => {
      this.network = "Live";
      this.reconnectAttempt = 0;
      this.lastSocketMessage = Date.now();
      void chrome.alarms.create("relay-reconnect", { periodInMinutes: 1 });
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastSocketMessage > 75_000) {
          this.disconnect();
          this.network = "Offline";
          this.scheduleReconnect();
          return;
        }
        if (socket.readyState === WebSocket.OPEN) socket.send("ping");
      }, 25_000);
      this.wake();
    };
    socket.onmessage = (event) => {
      this.lastSocketMessage = Date.now();
      if (event.data !== "pong") this.onSocketMessage(String(event.data));
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = undefined;
        clearInterval(this.heartbeat);
        this.network = "Offline";
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => socket.close();
  }
  async socketMessage(data: string) {
    if (data === "changed") {
      await this.captureLocal();
      await this.flush();
      return;
    }
    const message = JSON.parse(data) as { type: string; chain: Control[] };
    if (message.type === "revoked") await this.advanceChain(message.chain);
  }
  async reconnect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      await this.captureLocal();
      await this.flush();
    } else await this.connect();
  }
  private async wipeRevoked() {
    this.disconnect();
    await vault.wipe();
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
    await chrome.alarms.clearAll();
    this.local = undefined;
    this.signing = undefined;
    this.exchange = undefined;
    this.halted = true;
  }
  async watchdog() {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    )
      return;
    await this.connect();
  }
  async cancelSetup() {
    assert(!this.local || this.local.phase !== "active", "Use pause to stop an active account.");
    await this.wipeRevoked();
    this.halted = false;
    this.error = "";
    return this.status();
  }
  async status() {
    const s = this.local;
    const stats = await workspaceStats();
    let sas: string | undefined;
    const approvals = [];
    if (
      s?.request?.approverReveal &&
      s.request.status !== "denied" &&
      s.request.expires > Date.now()
    )
      sas = await this.pairSas(s.request, "requester");
    for (const pair of s?.approvals ?? []) {
      if (pair.expires <= Date.now()) continue;
      let code: string | undefined;
      if (pair.approverReveal && pair.offer?.device.id === s?.device.id)
        code = await this.pairSas(pair, "approver");
      approvals.push({
        id: pair.id,
        expires: pair.expires,
        sas: code,
        reviewing: !!pair.offer,
        ours: pair.offer?.device.id === s?.device.id,
      });
    }
    return {
      phase: s?.phase ?? "welcome",
      status: s?.paused ? "Paused" : this.network,
      error: this.error,
      server: s?.server ?? (__OFFICIAL_ORIGIN__ || (__DEV__ ? "http://localhost:8787" : "")),
      official: __OFFICIAL_ORIGIN__,
      groups: groupsAvailable()
        ? this.preferences.tabGroups
          ? "Tab groups available"
          : "Tab groups disabled on this device"
        : groupsEnabled()
          ? "Tab groups unavailable in this browser"
          : "Tab groups disabled for development",
      capabilities: { tabGroups: groupsAvailable() },
      preferences: this.preferences,
      development: __DEV__,
      account: s?.account,
      device: s?.device.id,
      name: s?.name,
      paused: s?.paused,
      recovery: s?.recoveryDisplay,
      stats,
      workspace: s
        ? {
            windows: Object.keys(s.canonical.windows).length,
            tabs: Object.keys(s.canonical.tabs).length,
          }
        : undefined,
      epoch: s?.control?.epoch,
      revision: s?.canonical.revision,
      queue: s?.queue.length ?? 0,
      lastSynced: s?.lastSynced,
      pair: s?.request
        ? {
            status: s.request.expires <= Date.now() ? "expired" : s.request.status,
            expires: s.request.expires,
            sas,
          }
        : undefined,
      approvals,
      devices:
        s?.control?.members.map((d) => ({
          id: d.id,
          name: this.projected().names[d.id] ?? "Relay device",
          ...s.presence[d.id],
        })) ?? [],
      diagnostics: __DEV__ ? s?.diagnostics : undefined,
      lifecycle: this.lifecycle,
      behavior: diagnosticSnapshot(),
    };
  }
}
export type Status = Awaited<ReturnType<Controller["status"]>>;
