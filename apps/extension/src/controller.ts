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
import { type ApprovalActivity, badgeText, recoverApprovalActivity } from "./approval-ui";
import {
  browserWindows,
  capture,
  ownOrigin,
  reconcile,
  sessionId,
  workspaceStats,
} from "./browser";
import { BrowserEvents, type Lifecycle } from "./browser-events";
import {
  browserWorkspace,
  diffWorkspace,
  type Mapping,
  navigationCircuit,
  navigationKey,
  recordLocalIntent,
} from "./browser-model";
import { asBrowserRuntimeRace } from "./browser-runtime";
import { diagnosticDevice, diagnosticSnapshot, trace } from "./diagnostics";
import { type FailureDisposition, failurePolicy } from "./failure-policy";
import { groupsAvailable, groupsEnabled, requireGroupSupport } from "./group-browser";
import { pruneCollapsedGroups, updateCollapsedGroup } from "./group-model";
import { committedNavigation, expectNavigation, remoteNavigationEvent } from "./navigation";
import {
  defaultSyncPreferences,
  loadSyncPreferences,
  type SyncPreferencesV1,
  saveSyncPreferences,
} from "./preferences";
import { RemoteChangeTracker } from "./remote-change-tracker";
import { settleBrowserRestore } from "./restore-settling";
import { reconnectDelay, SOCKET_STABLE_MS, socketNeedsReconnect } from "./socket-lifecycle";
import * as vault from "./vault";
import { initialMerge, restoreMapping } from "./workspace-lifecycle";

declare const __DEV__: boolean;
declare const __BUILD_CHANNEL__: "development" | "staging" | "production";
declare const __OFFICIAL_ORIGIN__: string;
const PAIR_REQUEST_LIFETIME_MS = 590_000;
const APPROVAL_RESULT_LIFETIME_MS = 10_000;
export const APPROVAL_EXPIRY_ALARM = "relay-approval-expiry";
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
  approvalActivity?: ApprovalActivity;
  presence: SyncReply["presence"];
  lastSynced: number;
  diagnostics: { operations: number; reconnects: number; snapshotBytes: number };
}
export class Controller {
  readonly events = new BrowserEvents();
  lifecycle: Lifecycle = "UNINITIALIZED";
  private remoteWindowCloses = new Map<number, number>();
  private reconcileGeneration = 0;
  private local?: Local;
  private signing?: CryptoKey;
  private exchange?: CryptoKey;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private reconnectAt = 0;
  private socketOpenedAt = 0;
  private lastSocketMessage = 0;
  private socketStartedAt = 0;
  private remoteChanges = new RemoteChangeTracker();
  private restoreCandidate?: Mapping;
  private startupDeletedTabs = new Set<string>();
  private startupDeletedWindows = new Set<string>();
  private startupNavigations = new Set<string>();
  private startTrace: string[] = [];
  private network = "Not connected";
  private error = "";
  private halted = false;
  private lastErrorCategory = "NONE";
  private lastErrorDisposition: "none" | FailureDisposition = "none";
  private loaded = false;
  private loadFailed = false;
  private persistedState?: string;
  private storageWrites = 0;
  private serverRequests = 0;
  private lastTransientError = "NONE";
  private lastFatalError = "NONE";
  pendingTasks: () => number = () => 0;
  get browserWorkPending() {
    return this.lifecycle === "LIVE" && !this.halted && this.events.readyAt > 0;
  }
  private lastCheckpoint = 0;
  private lastApprovalRefresh = 0;
  private preferences: SyncPreferencesV1 = defaultSyncPreferences();
  private api(): Api {
    const s = this.require();
    return new Api(
      s.server,
      s.handle,
      (event) => this.recordStartTrace(event),
      () => {
        this.serverRequests++;
      },
    );
  }
  private recordStartTrace(event: string) {
    if (!__DEV__) return;
    this.startTrace.push(event);
    if (this.startTrace.length > 60) this.startTrace.shift();
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
  private async persist() {
    const state = JSON.stringify(this.require());
    if (state === this.persistedState) return;
    // Snapshot before the first await; browser callbacks can update receipts while
    // encryption/storage is in flight. Never acknowledge data we did not save.
    await vault.saveState(JSON.parse(state));
    this.persistedState = state;
    this.storageWrites++;
  }
  private auth<T>(action: string, payload: unknown) {
    return this.api().authenticated<T>(action, payload, this.require().device.id, this.key());
  }
  private async updateApprovalBadge() {
    await chrome.action.setBadgeText({ text: badgeText(this.local?.approvals ?? []) });
    await chrome.action.setBadgeBackgroundColor({ color: "#4f6cff" });
    const nextExpiry = this.local?.approvals
      .filter((pair) => pair.expires > Date.now())
      .sort((left, right) => left.expires - right.expires)[0]?.expires;
    if (nextExpiry) await chrome.alarms.create(APPROVAL_EXPIRY_ALARM, { when: nextExpiry + 1 });
    else await chrome.alarms.clear(APPROVAL_EXPIRY_ALARM);
  }
  private async pruneExpiredApprovals() {
    const s = this.local;
    if (!s) {
      await this.updateApprovalBadge();
      return;
    }
    let changed = false;
    const valid = s.approvals.filter((pair) => pair.expires > Date.now());
    if (
      s.approvalActivity?.finishedAt &&
      s.approvalActivity.finishedAt + APPROVAL_RESULT_LIFETIME_MS <= Date.now()
    ) {
      delete s.approvalActivity;
      changed = true;
    }
    if (valid.length !== s.approvals.length) {
      const activeIds = new Set(valid.map((pair) => pair.id));
      for (const requestId of Object.keys(s.pairSecrets))
        if (requestId !== s.request?.id && !activeIds.has(requestId)) {
          delete s.pairSecrets[requestId];
          await vault.remove(`ephemeral:${requestId}`);
        }
      if (
        s.approvalActivity?.status === "working" &&
        !activeIds.has(s.approvalActivity.requestId)
      ) {
        s.approvalActivity.status = "failed";
        s.approvalActivity.finishedAt = Date.now();
        s.approvalActivity.error = "Request expired.";
      }
      s.approvals = valid;
      changed = true;
    }
    if (changed) await this.persist();
    await this.updateApprovalBadge();
  }
  private reconcileApprovalActivity() {
    const s = this.local;
    const activity = s?.approvalActivity;
    if (!s || !activity) return;
    s.approvalActivity = recoverApprovalActivity(
      activity,
      new Set(s.approvals.map((pair) => pair.id)),
      new Set(s.control?.members.map((device) => device.id)),
    );
  }
  private approvalError(error: unknown, action: "approve" | "deny") {
    if (error instanceof ApiError) {
      if (error.status === 404 || error.status === 410) return "Request expired.";
      if (error.status === 0) return "Relay server unavailable. Try again.";
      if (/ALREADY|AUTHORIZED/.test(error.code)) return "Device is already authorized.";
      if (/PROTOCOL|VERSION/.test(error.code)) return "Pairing protocol mismatch.";
      if (/SIGNATURE|VERIFY|VALIDATION/.test(error.code)) return "Verification failed.";
    }
    const message = error instanceof Error ? error.message : "";
    if (/expired/i.test(message)) return "Request expired.";
    if (/no longer|unavailable/i.test(message)) return "Request no longer exists.";
    if (/verification codes/i.test(message)) return "Verification failed. Compare the codes again.";
    return action === "approve" ? "Could not approve device." : "Could not deny request.";
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
      await this.pruneExpiredApprovals();
      if (this.local.phase === "active") {
        await this.hydrate();
        if (!this.local.paused) await this.connect();
      }
    } catch (error) {
      if (
        failurePolicy(error).category === "STORAGE_INTERRUPTED" &&
        this.lifecycle === "LOADING_LOCAL_STATE"
      ) {
        this.loaded = false;
        // Retry the complete authenticated local load; partial identity is unusable.
        this.local = undefined;
        this.signing = undefined;
        this.exchange = undefined;
        await chrome.alarms.create("relay-reconnect", { when: Date.now() + 30_000 });
        throw error;
      }
      if (!this.local) this.loadFailed = true;
      this.failure(error);
    }
  }
  private clearStartupTracking() {
    this.restoreCandidate = undefined;
    this.startupDeletedTabs.clear();
    this.startupDeletedWindows.clear();
    this.startupNavigations.clear();
  }
  private startupChanges(target: Workspace, mapping: Mapping, created: Change[]): Change[] {
    return [
      ...created,
      ...diffWorkspace(target, mapping.observed).filter((change) => {
        if (change.type === "tab-delete") return this.startupDeletedTabs.has(change.id);
        if (change.type === "window-delete") return this.startupDeletedWindows.has(change.id);
        if (change.type === "tab-navigate") return this.startupNavigations.has(change.id);
        return false;
      }),
    ];
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
    const resumingFromStopped = this.lifecycle === "STOPPED";
    const session = await sessionId();
    let actual;
    this.clearStartupTracking();
    if (s.mapping.session !== session) {
      this.lifecycle = "WAITING_FOR_BROWSER_RESTORE";
      const settled = await settleBrowserRestore({
        read: browserWindows,
        previous: s.mapping,
        target: this.projected(),
        session,
        source: s.device.id,
        origin: ownOrigin(),
        quietAt: () => this.events.quietAt,
        sampled: (sample) => {
          this.restoreCandidate = sample.mapping;
        },
      });
      actual = settled.actual;
      if (!actual.length) {
        this.clearStartupTracking();
        await this.stopped();
        return;
      }
      const localTarget = this.projected();
      const adoptedGeneration = this.events.generation;
      const adopted = restoreMapping(
        actual,
        this.restoreCandidate ?? s.mapping,
        localTarget,
        session,
        s.device.id,
        ownOrigin(),
      );
      s.mapping = adopted.mapping;
      await this.enqueue(
        this.startupChanges(localTarget, adopted.mapping, adopted.changes),
        "STARTUP",
      );
      await this.persist();
      // Native restoration and explicitly attributed startup actions are now adopted.
      // Events arriving after this point belong to ordinary browser use during the pull.
      if (this.events.generation === adoptedGeneration) this.events.clear();
      this.clearStartupTracking();
    } else {
      actual = await browserWindows();
      if (!actual.length) {
        await this.stopped();
        return;
      }
      if (resumingFromStopped) {
        const adopted = restoreMapping(
          actual,
          s.mapping,
          this.projected(),
          session,
          s.device.id,
          ownOrigin(),
        );
        s.mapping = adopted.mapping;
        await this.enqueue(adopted.changes, "STARTUP");
        await this.persist();
        // Chrome's starter window replaces the closed last window in this browser lifetime.
        this.events.clear();
      }
    }
    this.lifecycle = "FETCHING_CANONICAL_STATE";
    if (!s.paused) await this.pull();
    while (this.events.readyAt > Date.now())
      await new Promise((resolve) => setTimeout(resolve, this.events.readyAt - Date.now()));
    this.lifecycle = "LIVE";
    await this.captureLocal();
    if ((this.lifecycle as Lifecycle) === "STOPPED") return;
    this.lifecycle = "FETCHING_CANONICAL_STATE";
    actual = await browserWindows();
    if (!actual.length) {
      await this.stopped();
      return;
    }
    this.lifecycle = "RECONCILING";
    const restored = restoreMapping(
      actual,
      this.restoreCandidate ?? s.mapping,
      this.projected(),
      session,
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
    // Keep events received during awaited browser mutations. Expected-operation
    // suppression consumes our callbacks; later user commits still need capture.
    this.lifecycle = "LIVE";
    await this.persist();
    if (this.remoteChanges.dirty) await this.flush();
  }
  navigationEvent(local: number, url: string, complete: boolean) {
    if (this.local && remoteNavigationEvent(this.local.mapping, local, url, complete)) {
      // Still schedule one settled observation, never an immediate operation per callback.
      this.events.navigation(local, url, complete);
      return;
    }
    this.recordNavigationIntent(local, url);
    this.events.navigation(local, url, complete);
  }
  navigationCommitted(local: number, url: string, transition: string, qualifiers: string[]) {
    if (
      this.lifecycle === "WAITING_FOR_BROWSER_RESTORE" &&
      transition !== "reload" &&
      !qualifiers.includes("forward_back")
    ) {
      const logical = this.restoreCandidate?.tabs[local];
      if (logical) this.startupNavigations.add(logical);
    }
    if (this.local) committedNavigation(this.local.mapping, local, url, transition, qualifiers);
    this.events.committed(local, url, transition, qualifiers);
  }
  windowRemoved(local: number) {
    if ((this.remoteWindowCloses.get(local) ?? 0) > Date.now()) {
      trace("REMOTE", "WINDOW_DELETE", "SUPPRESS");
      return;
    }
    if (this.lifecycle === "WAITING_FOR_BROWSER_RESTORE") {
      const logical = this.restoreCandidate?.windows[local];
      if (logical) this.startupDeletedWindows.add(logical);
    }
    this.events.windowRemoved(local);
  }
  tabRemoved(local: number, window: number, isWindowClosing: boolean) {
    if (isWindowClosing) {
      this.windowRemoved(window);
      return;
    }
    if (this.lifecycle === "WAITING_FOR_BROWSER_RESTORE") {
      const logical = this.restoreCandidate?.tabs[local];
      if (logical) this.startupDeletedTabs.add(logical);
    }
    this.recordDeleteIntent(local);
    this.events.removed(local, window, false);
  }
  private recordNavigationIntent(local: number, url: string) {
    const s = this.local;
    const id = s?.mapping.tabs[local];
    const previous = id ? s.mapping.observed.tabs[id] : undefined;
    if (!s || !id || !previous || navigationKey(previous) === url) return;
    const intent = recordLocalIntent(s.mapping, id, {
      kind: "navigate",
      url,
      canonicalRevision: s.canonical.revision,
    });
    trace("USER", "TAB_NAVIGATE", "DETECTED", id, "", `intent:${intent.generation}`);
    // Persist before the debounced capture/journal transaction so service-worker
    // restart cannot resurrect an immediately closed or navigated tab from an old pull.
    void this.persist().catch(() => {});
  }
  private recordDeleteIntent(local: number) {
    const s = this.local;
    const id = s?.mapping.tabs[local];
    if (!s || !id) return;
    const expected = s.mapping.expected.some(
      (event) =>
        event.resource === id && event.mutation === "tab-delete" && event.expires > Date.now(),
    );
    if (expected) return;
    const intent = recordLocalIntent(s.mapping, id, {
      kind: "delete",
      canonicalRevision: s.canonical.revision,
    });
    trace("USER", "TAB_DELETE", "DETECTED", id, "", `intent:${intent.generation}`);
    void this.persist().catch(() => {});
  }
  async groupUpdated(local: number, collapsed: boolean) {
    if (this.local && updateCollapsedGroup(this.local.mapping, local, collapsed))
      await this.persist();
  }
  failure(error: unknown) {
    const browserRace = asBrowserRuntimeRace(error);
    const policy = failurePolicy(error);
    this.error = browserRace
      ? "The browser changed while Relay was reconciling. Relay will retry automatically."
      : error instanceof Error
        ? error.message
        : "Relay could not complete this action.";
    this.lastErrorCategory = policy.category;
    this.lastErrorDisposition = policy.disposition;
    if (policy.disposition === "transient") this.lastTransientError = policy.category;
    if (policy.disposition === "fatal") this.lastFatalError = policy.category;
    if (policy.category === "NETWORK") {
      this.network = "Offline";
      this.disconnect();
      this.scheduleReconnect();
    } else if (policy.disposition === "transient") {
      if (this.socket?.readyState !== WebSocket.OPEN) this.network = "Recovering";
      this.scheduleReconnect();
    } else if (policy.disposition === "action-required") {
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
    this.startTrace = [];
    this.recordStartTrace("Controller.start entered");
    if (__DEV__) console.debug("[Relay start] entered Controller.start");
    const s = this.require();
    assert(s.phase === "draft" && s.control && s.root, "Account setup is incomplete.");
    this.halted = false;
    this.error = "";
    this.recordStartTrace("Draft state valid");
    if (__DEV__) console.debug("[Relay start] draft state valid");
    if (__DEV__) {
      const origin = serverOrigin(s.server, true);
      this.recordStartTrace(`[Relay:start] canonical server = ${origin}`);
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      this.recordStartTrace(`[Relay:start] host permission = ${granted}`);
    }
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
    this.recordStartTrace("Initial snapshot ready");
    if (__DEV__) console.debug("[Relay start] initial snapshot ready");
    if (__DEV__) console.debug("[Relay start] calling Api.post(create)");
    this.recordStartTrace("Calling Api.post(create)");
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
  async health(server: string) {
    if (!__DEV__) throw new Error("Server diagnostics are available only in development builds.");
    this.startTrace = [];
    try {
      const origin = serverOrigin(server, true);
      this.recordStartTrace(`[Relay:health] canonical server = ${origin}`);
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      this.recordStartTrace(`[Relay:health] host permission = ${granted}`);
      await new Api(origin, "", (event) => this.recordStartTrace(event)).health();
      return { ok: true, message: "Relay protocol v1 connected (HTTP 200)." };
    } catch (error) {
      // A user-initiated probe must not halt an otherwise active account.
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Connection test failed.",
      };
    }
  }
  async join(server: string, account: string, name: string) {
    this.startTrace = [];
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
      expires: Date.now() + PAIR_REQUEST_LIFETIME_MS,
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
    let secret = s.pairSecrets[requestId];
    if (!secret?.request) {
      const pair = await ephemeral();
      secret = {
        reveal: pair.reveal,
        commitment: pair.commitment,
        request: pairStart(pending),
      };
      s.pairSecrets[requestId] = secret;
      await vault.write(`ephemeral:${requestId}`, pair.privateKey);
      await this.persist();
    }
    await this.auth("pair-offer", { id: requestId, commitment: secret.commitment });
    await this.pull();
    return this.status();
  }
  async approve(requestId: string, code: string) {
    const s = this.require();
    if (
      s.approvalActivity?.requestId === requestId &&
      s.approvalActivity.action === "approve" &&
      s.approvalActivity.status !== "failed"
    )
      return this.status();
    const pair = s.approvals.find((p) => p.id === requestId);
    assert(pair && pair.offer?.device.id === s.device.id && s.control);
    s.approvalActivity = {
      requestId,
      deviceId: pair.device.id,
      action: "approve",
      status: "working",
      startedAt: Date.now(),
    };
    await this.persist();
    try {
      assert(code === (await this.pairSas(pair, "approver")), "Verification codes do not match.");
      const control = await this.addMember(pair.device, this.key(), s.device.id);
      await this.auth("pair-approve", { id: requestId, control });
      s.approvalActivity.status = "approved";
      s.approvalActivity.finishedAt = Date.now();
      await this.pull();
      await this.persist();
      return this.status();
    } catch (error) {
      s.approvalActivity.status = "failed";
      s.approvalActivity.finishedAt = Date.now();
      s.approvalActivity.error = this.approvalError(error, "approve");
      await this.persist();
      throw error;
    }
  }
  async deny(requestId: string) {
    const s = this.require();
    if (
      s.approvalActivity?.requestId === requestId &&
      s.approvalActivity.action === "deny" &&
      s.approvalActivity.status !== "failed"
    )
      return this.status();
    const pair = s.approvals.find((candidate) => candidate.id === requestId);
    assert(pair, "Request is no longer available.");
    s.approvalActivity = {
      requestId,
      deviceId: pair.device.id,
      action: "deny",
      status: "working",
      startedAt: Date.now(),
    };
    await this.persist();
    try {
      await this.auth("pair-deny", { id: requestId });
      s.approvalActivity.status = "denied";
      s.approvalActivity.finishedAt = Date.now();
      await this.pull();
      await this.persist();
      return this.status();
    } catch (error) {
      s.approvalActivity.status = "failed";
      s.approvalActivity.finishedAt = Date.now();
      s.approvalActivity.error = this.approvalError(error, "deny");
      await this.persist();
      throw error;
    }
  }
  async refreshApprovals() {
    const s = this.local;
    try {
      if (s?.phase === "active" && s.control && Date.now() - this.lastApprovalRefresh > 1_000)
        await this.pull();
      else await this.pruneExpiredApprovals();
    } catch (error) {
      if (s?.approvalActivity?.status === "working") {
        s.approvalActivity.status = "failed";
        s.approvalActivity.finishedAt = Date.now();
        s.approvalActivity.error = this.approvalError(error, s.approvalActivity.action);
        await this.persist();
      }
      throw error;
    }
    return this.status();
  }
  async dismissApprovalResult() {
    const s = this.local;
    if (s?.approvalActivity && s.approvalActivity.status !== "working") {
      delete s.approvalActivity;
      await this.persist();
    }
    return this.status();
  }
  async expireApprovals() {
    await this.pruneExpiredApprovals();
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
    this.startTrace = [];
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
    const state = structuredClone(this.synchronizedWorkspace());
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
    return browserWorkspace(state);
  }
  private synchronizedWorkspace(): Workspace {
    const s = this.require();
    let state = s.canonical;
    for (const entry of s.queue)
      state = applyOperation(
        state,
        { ...entry.operation, base: state.revision },
        state.revision + 1,
      );
    return state;
  }
  private pruneLocalGroupState() {
    const s = this.require();
    pruneCollapsedGroups(s.mapping, this.synchronizedWorkspace());
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
    this.pruneLocalGroupState();
    s.diagnostics.operations++;
    const operation = s.queue.at(-1)!.operation;
    const localTabs = new Map(
      Object.entries(s.mapping.tabs).map(([local, logical]) => [logical, Number(local)]),
    );
    for (const change of changes) {
      const logical =
        change.type === "tab-create" ? change.tab.id : "id" in change ? change.id : undefined;
      if (logical) {
        const intent = s.mapping.freshness?.intents[logical];
        if (intent) intent.journaled = true;
      }
      if (change.type === "tab-navigate" || change.type === "tab-create") {
        const tabId = change.type === "tab-create" ? change.tab.id : change.id;
        const tab = s.mapping.observed.tabs[tabId];
        const local = localTabs.get(tabId);
        if (tab && local !== undefined)
          expectNavigation(s.mapping, tab, local, undefined, operation.id, "USER");
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
    let result: Awaited<ReturnType<typeof capture>>;
    try {
      result = await capture(s.mapping, s.device.id, evidence, this.projected());
    } catch (error) {
      this.events.restore(evidence);
      throw error;
    }
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
    if (this.reconnectAt > Date.now() && this.socket?.readyState !== WebSocket.OPEN) return;
    if (
      (changed ||
        this.remoteChanges.dirty ||
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
    const planGeneration = ++this.reconcileGeneration;
    const intentGeneration = s.mapping.freshness?.generation ?? 0;
    const occupied = new Set(Object.values(target.tabs).map((tab) => tab.window));
    for (const [local, expires] of this.remoteWindowCloses)
      if (expires <= Date.now()) this.remoteWindowCloses.delete(local);
    for (const [local, logical] of Object.entries(s.mapping.windows))
      if (!occupied.has(logical)) this.remoteWindowCloses.set(Number(local), Date.now() + 15_000);
    const previousLifecycle = this.lifecycle;
    this.lifecycle = "RECONCILING";
    await this.persist();
    try {
      s.mapping = await reconcile(
        target,
        s.mapping,
        s.device.id,
        async (mapping) => {
          // Browser callbacks are not serialized with this reconciliation. Keep any
          // newer direct user intent when reconcile persists an older mapping clone.
          mapping.freshness = structuredClone(s.mapping.freshness);
          s.mapping = mapping;
          await this.persist();
        },
        (tab, mutation) => {
          if (this.events.closing || planGeneration !== this.reconcileGeneration) return false;
          const freshness = s.mapping.freshness;
          if ((freshness?.generation ?? 0) !== intentGeneration) return false;
          if (!tab) return true;
          const intent = freshness?.intents[tab.id];
          if (!intent) return true;
          if (intent.kind === "delete") return false;
          return mutation !== "navigate" || navigationKey(tab) === intent.url;
        },
        (tab) => {
          const intent = tab ? s.mapping.freshness?.intents[tab.id] : undefined;
          return `rev:${target.revision};plan:${planGeneration};intent:${intent?.generation ?? intentGeneration};delete:${intent?.kind === "delete"}`;
        },
      );
    } catch (error) {
      if (this.events.closing) return; // Keep durable intent; the close transaction decides next.
      throw asBrowserRuntimeRace(error) ?? error;
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
    const requestedRemoteGeneration = this.remoteChanges.snapshot();
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
    this.settleLocalIntents();
    this.pruneLocalGroupState();
    s.nextSequence = Math.max(s.nextSequence, reply.sequence + 1);
    assert(Array.isArray(reply.pending) && reply.pending.length <= LIMITS.pending);
    s.approvals = reply.pending.map(parsePair);
    this.reconcileApprovalActivity();
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
    this.remoteChanges.acknowledge(requestedRemoteGeneration);
    this.lastApprovalRefresh = Date.now();
    await this.updateApprovalBadge();
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
  private settleLocalIntents() {
    const s = this.require();
    const intents = s.mapping.freshness?.intents;
    if (!intents) return;
    const pending = new Set(
      s.queue.flatMap((entry) =>
        entry.operation.changes.flatMap((change) =>
          change.type === "tab-create" ? [change.tab.id] : "id" in change ? [change.id] : [],
        ),
      ),
    );
    for (const [id, intent] of Object.entries(intents)) {
      if (!intent.journaled) continue;
      if (pending.has(id)) continue;
      const canonical = s.canonical.tabs[id];
      // A signed pull acknowledging our sequence makes the canonical outcome
      // deterministic. It may be our local value or a later concurrent winner.
      if (intent.kind === "delete" ? !canonical : true) delete intents[id];
    }
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
    this.reconnectTimer = undefined;
    this.reconnectAt = 0;
    this.socketOpenedAt = 0;
    this.heartbeat = undefined;
    this.socketStartedAt = 0;
    const old = this.socket;
    this.socket = undefined;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
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
    if (this.reconnectTimer) return;
    const delay = reconnectDelay(this.reconnectAttempt++);
    this.reconnectAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectAt = 0;
      this.wake();
    }, delay);
    void chrome.alarms.create("relay-reconnect", { when: Date.now() + Math.max(30_000, delay) });
  }
  wake: () => void = () => {};
  onSocketMessage: (data: string) => void = () => {};
  async connect() {
    const s = this.local;
    if (!s || s.phase !== "active" || s.paused || this.halted) return;
    // Install a durable wake before any network await or CONNECTING socket. An
    // interrupted first connection must not depend on a JS timer surviving MV3.
    await chrome.alarms.create("relay-reconnect", { periodInMinutes: 1 });
    if (this.lifecycle !== "LIVE") await this.hydrate();
    if (this.lifecycle !== "LIVE" || this.events.closing) return;
    this.disconnect();
    this.network = "Connecting";
    await this.flush();
    const { ticket } = await this.auth<{ ticket: string }>("socket-ticket", {});
    const url = new URL(`${s.server}/v1/${s.handle}/socket`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("ticket", ticket);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (cause) {
      throw new ApiError(
        0,
        "Relay live connection could not start. Your local changes are saved.",
        "SOCKET_OPEN_FAILED",
        "SOCKET",
        cause,
      );
    }
    this.socket = socket;
    this.socketStartedAt = Date.now();
    s.diagnostics.reconnects++;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.network = "Live";
      this.socketOpenedAt = Date.now();
      this.socketStartedAt = 0;
      this.lastSocketMessage = Date.now();
      void chrome.alarms.create("relay-reconnect", { periodInMinutes: 1 });
      this.heartbeat = setInterval(() => {
        if (this.socket !== socket) return;
        if (Date.now() - this.lastSocketMessage > 75_000) {
          this.disconnect();
          this.network = "Offline";
          this.scheduleReconnect();
          return;
        }
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send("ping");
          } catch {
            this.disconnect();
            this.network = "Offline";
            this.scheduleReconnect();
          }
        }
      }, 25_000);
      this.wake();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastSocketMessage = Date.now();
      if (Date.now() - this.socketOpenedAt >= SOCKET_STABLE_MS) this.reconnectAttempt = 0;
      if (event.data === "changed") this.remoteChanges.note();
      if (event.data !== "pong") this.onSocketMessage(String(event.data));
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.disconnect();
        this.network = "Offline";
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.disconnect();
      this.network = "Offline";
      this.scheduleReconnect();
    };
    // Handlers must exist before yielding to a storage write: open/close can fire
    // before IndexedDB completes, especially on a busy large-session startup.
    await this.persist();
  }
  async socketMessage(data: string) {
    if (data === "changed") {
      if (this.lifecycle !== "LIVE" || !this.remoteChanges.dirty) return;
      if (this.reconnectAt > Date.now() && this.socket?.readyState !== WebSocket.OPEN) return;
      await this.captureLocal();
      await this.flush();
      return;
    }
    const message = JSON.parse(data) as { type: string; chain: Control[] };
    if (message.type === "revoked") await this.advanceChain(message.chain);
  }
  async reconnect() {
    if (this.local?.paused || this.halted) return;
    if (this.lifecycle !== "LIVE") {
      await this.connect();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      await this.captureLocal();
      await this.flush();
    } else if (
      socketNeedsReconnect(this.socket?.readyState, this.socketStartedAt, this.lastSocketMessage)
    )
      await this.connect();
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
    if (this.reconnectAt > Date.now()) return;
    if (
      !socketNeedsReconnect(this.socket?.readyState, this.socketStartedAt, this.lastSocketMessage)
    )
      return;
    if (this.socket) {
      this.disconnect();
      this.network = "Offline";
    }
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
    await this.pruneExpiredApprovals();
    const stats = await workspaceStats();
    const projected = s ? this.projected() : undefined;
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
        requestedAt: pair.expires - PAIR_REQUEST_LIFETIME_MS,
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
      channel: __BUILD_CHANNEL__,
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
      approvalActivity: s?.approvalActivity
        ? {
            ...s.approvalActivity,
            connected:
              s.approvalActivity.action === "approve" &&
              !!s.presence[s.approvalActivity.deviceId]?.online,
          }
        : undefined,
      devices:
        s?.control?.members.map((d) => ({
          id: d.id,
          name: projected?.names[d.id] ?? "Relay device",
          ...s.presence[d.id],
        })) ?? [],
      diagnostics: __DEV__ ? s?.diagnostics : undefined,
      lifecycle: this.lifecycle,
      runtime: __DEV__
        ? {
            lifecycle: this.lifecycle,
            halted: this.halted,
            paused: s?.paused ?? false,
            socketReadyState: this.socket?.readyState ?? WebSocket.CLOSED,
            reconnectAttempt: this.reconnectAttempt,
            reconnectBackoff: Math.max(0, this.reconnectAt - Date.now()),
            pendingTasks: this.pendingTasks(),
            network: this.network,
            storageWrites: this.storageWrites,
            serverRequests: this.serverRequests,
            lastTransientError: this.lastTransientError,
            lastFatalError: this.lastFatalError,
            lastSocketMessageAge:
              this.lastSocketMessage > 0 ? Date.now() - this.lastSocketMessage : undefined,
            events: this.events.summary(),
            queue: s?.queue.length ?? 0,
            canonicalRevision: s?.canonical.revision,
            projected: projected
              ? {
                  revision: projected.revision,
                  windows: Object.keys(projected.windows).length,
                  tabs: Object.keys(projected.tabs).length,
                  groups: Object.keys(projected.groups).length,
                }
              : undefined,
            intent: !!s?.intent,
            remoteDirty: this.remoteChanges.dirty,
            lastErrorCategory: this.lastErrorCategory,
            lastErrorDisposition: this.lastErrorDisposition,
          }
        : undefined,
      behavior: diagnosticSnapshot(),
      startTrace: __DEV__ ? [...this.startTrace] : undefined,
    };
  }
}
export type Status = Awaited<ReturnType<Controller["status"]>>;
