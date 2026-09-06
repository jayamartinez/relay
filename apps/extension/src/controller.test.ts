import { base64, encryptEnvelope } from "@relay/crypto";
import { emptyWorkspace, type Operation, type SyncReply } from "@relay/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../../../tests/fixtures";
import { ApiError } from "./api";
import { browserWindows, capture, reconcile, sessionId } from "./browser";
import { BrowserRuntimeRaceError } from "./browser-runtime";
import { Controller } from "./controller";
import { SerialTaskQueue } from "./serial-task-queue";
import { StorageInterruptedError } from "./storage-runtime";
import * as vault from "./vault";

vi.mock("./vault", () => ({
  saveState: vi.fn(async () => {}),
  loadState: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("./browser", () => ({
  browserWindows: vi.fn(),
  capture: vi.fn(),
  reconcile: vi.fn(),
  sessionId: vi.fn(),
  ownOrigin: () => "chrome-extension://relay",
  workspaceStats: async () => ({ windows: 1, tabs: 0, local: 0 }),
}));
class Socket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static all: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() {
    Socket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  send = vi.fn();
  message(data: string) {
    this.onmessage?.({ data });
  }
}
function setup() {
  const controller = new Controller();
  controller["local"] = {
    version: 1,
    phase: "active",
    server: "https://relay.example",
    account: "",
    handle: "",
    name: "Test",
    device: { id: crypto.randomUUID(), auth: "test", exchange: "test" },
    canonical: emptyWorkspace(),
    queue: [],
    nextSequence: 1,
    mapping: {
      session: "session",
      windows: {},
      tabs: {},
      expected: [],
      observed: emptyWorkspace(),
    },
    paused: false,
    pairSecrets: {},
    approvals: [],
    presence: {},
    lastSynced: 0,
    diagnostics: { operations: 0, reconnects: 0, snapshotBytes: 0 },
  };
  controller.lifecycle = "LIVE";
  vi.spyOn(controller, "flush").mockResolvedValue();
  vi.spyOn(controller, "pull").mockResolvedValue();
  controller["auth"] = vi.fn(async () => ({ ticket: "test" })) as (typeof controller)["auth"];
  vi.mocked(capture).mockImplementation(async (mapping) => ({
    mapping: structuredClone(mapping),
    changes: [],
    bootstrap: false,
    shutdown: false,
  }));
  vi.mocked(reconcile).mockImplementation(async (target, mapping) => ({
    ...mapping,
    observed: target,
  }));
  vi.mocked(browserWindows).mockResolvedValue([{ local: 1, tabs: [] }]);
  vi.mocked(sessionId).mockResolvedValue("session");
  return controller;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("__DEV__", true);
  vi.stubGlobal("chrome", {
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    storage: { local: { get: async () => ({}), set: vi.fn() } },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("controller transport recovery", () => {
  it("installs socket callbacks before a blocked persistence write and ignores retired callbacks", async () => {
    const c = setup();
    let saved!: () => void;
    vi.mocked(vault.saveState).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          saved = resolve;
        }),
    );
    const connecting = c.connect();
    await vi.waitFor(() => expect(Socket.all).toHaveLength(1));
    const old = Socket.all[0]!;
    const lateOpen = old.onopen!;
    const lateMessage = old.onmessage!;
    old.open();
    expect(c["network"]).toBe("Live");
    saved();
    await connecting;
    await c.connect();
    lateOpen();
    lateMessage({ data: "changed" });
    expect(c["network"]).toBe("Connecting");
    expect(c["remoteChanges"].dirty).toBe(false);
  });
  it("backs off repeated open/close failures, resets only after stable traffic, then syncs again", async () => {
    const c = setup();
    c.wake = () => {
      void c.reconnect();
    };
    await c.connect();
    for (let attempt = 1; attempt <= 5; attempt++) {
      Socket.all.at(-1)!.open();
      await Promise.resolve();
      Socket.all.at(-1)!.close();
      expect(c["reconnectAttempt"]).toBe(attempt);
      const delay = c["reconnectAt"] - Date.now();
      expect(delay).toBeGreaterThanOrEqual(750 * 2 ** (attempt - 1));
      await vi.advanceTimersByTimeAsync(delay);
    }
    const socket = Socket.all.at(-1)!;
    socket.open();
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      socket.message("pong");
    }
    expect(c["reconnectAttempt"]).toBe(0);
    c.events.changed(0);
    await c.browserChanged();
    expect(capture).toHaveBeenCalled();
    expect(c["halted"]).toBe(false);
  });
  it.each(["close", "error", "stale", "connecting"])(
    "automatically recovers a %s socket and processes the next event",
    async (kind) => {
      const c = setup();
      c.wake = () => {
        void c.reconnect();
      };
      await c.connect();
      const socket = Socket.all[0]!;
      if (kind !== "connecting") socket.open();
      if (kind === "close") socket.close();
      if (kind === "error") socket.onerror?.();
      if (kind === "stale") await vi.advanceTimersByTimeAsync(101_000);
      else if (kind === "connecting") {
        await vi.advanceTimersByTimeAsync(21_000);
        await c.watchdog();
      } else await vi.advanceTimersByTimeAsync(1_001);
      expect(Socket.all.length).toBeGreaterThan(1);
      Socket.all.at(-1)!.open();
      await c.reconnect();
      c.events.changed(0);
      await c.browserChanged();
      expect(capture).toHaveBeenCalled();
      expect(c["halted"]).toBe(false);
    },
  );
  it("does not replace an in-progress connection or push for each offline browser event", async () => {
    const c = setup();
    await c.connect();
    await c.reconnect();
    expect(Socket.all).toHaveLength(1);
    c.failure(new ApiError(0, "offline"));
    vi.mocked(c.flush).mockClear();
    for (let i = 0; i < 20; i++) {
      c.events.changed(0);
      await c.browserChanged();
    }
    expect(c.flush).not.toHaveBeenCalled();
    expect(c["halted"]).toBe(false);
  });
});

describe("controller bounded sync pull", () => {
  it("applies contiguous encrypted pages before acknowledging queued local work", async () => {
    const f = await fixture();
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    const queued: Operation = {
      id: "queued",
      sender: f.device.device.id,
      sequence: 3,
      base: 0,
      changes: [{ type: "window-create", id: "queued-window", order: 0 }],
    };
    Object.assign(c["local"]!, {
      handle: f.handle,
      device: f.device.device,
      root: base64(f.root),
      control: f.control,
      canonical: f.workspace,
      queue: [{ sequence: 3, operation: queued }],
      nextSequence: 4,
    });
    c["signing"] = f.device.signing;
    const first: Operation = {
      id: "first",
      sender: f.device.device.id,
      sequence: 1,
      base: 0,
      changes: [{ type: "window-create", id: "remote-window", order: 0 }],
    };
    const second: Operation = {
      id: "second",
      sender: f.device.device.id,
      sequence: 2,
      base: 1,
      changes: [{ type: "window-delete", id: "remote-window" }],
    };
    const envelope = (operation: Operation) =>
      encryptEnvelope(
        f.root,
        f.device.signing,
        {
          version: 1,
          account: f.handle,
          epoch: 1,
          sender: f.device.device.id,
          sequence: operation.sequence,
          base: operation.base,
          type: "operation",
        },
        operation,
      );
    const firstEnvelope = await envelope(first);
    const secondEnvelope = await envelope(second);
    const pages: SyncReply[] = [
      {
        control: f.control,
        chain: [],
        operations: [{ revision: 1, envelope: firstEnvelope }],
        from: 0,
        next: 1,
        more: true,
        revision: 2,
        sequence: 2,
        pending: [],
        presence: {},
      },
      {
        control: f.control,
        chain: [],
        operations: [{ revision: 2, envelope: secondEnvelope }],
        from: 1,
        next: 2,
        more: false,
        revision: 2,
        sequence: 2,
        pending: [],
        presence: {},
      },
    ];
    c["auth"] = vi.fn(async (action: string, payload: { since: number; pagination: boolean }) => {
      expect(action).toBe("sync");
      expect(payload.pagination).toBe(true);
      if (payload.since === 0) return pages[0]!;
      expect(c["local"]!.canonical.revision).toBe(1);
      expect(c["local"]!.queue).toHaveLength(1);
      return pages[1]!;
    }) as (typeof c)["auth"];

    await c.pull();

    expect(c["local"]!.canonical.revision).toBe(2);
    expect(c["local"]!.canonical.windows).toEqual({});
    expect(c["local"]!.queue).toEqual([{ sequence: 3, operation: queued }]);
    expect(c["auth"]).toHaveBeenCalledTimes(2);
  });

  it("fails safely when a claimed continuation does not advance", async () => {
    const f = await fixture();
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    Object.assign(c["local"]!, {
      handle: f.handle,
      device: f.device.device,
      root: base64(f.root),
      control: f.control,
      canonical: f.workspace,
    });
    c["signing"] = f.device.signing;
    c["auth"] = vi.fn(async () => ({
      control: f.control,
      chain: [],
      operations: [],
      from: 0,
      next: 0,
      more: true,
      revision: 1,
      sequence: 0,
      pending: [],
      presence: {},
    })) as (typeof c)["auth"];
    await expect(c.pull()).rejects.toThrow("Sync continuation made no progress.");
  });
});

it("retains consumed close/navigation evidence after a transient capture failure; later browser and socket tasks run", async () => {
  const c = setup();
  const queue = new SerialTaskQueue();
  c.events.removed(10, 1, false, 0);
  c.events.navigation(11, "https://example.com/new", true, 0);
  vi.mocked(capture).mockRejectedValueOnce(new BrowserRuntimeRaceError());
  await expect(
    queue.run(
      () => c.browserChanged(),
      (e) => c.failure(e),
    ),
  ).rejects.toThrow();
  expect(c.events.pending.closedTabs.has(10)).toBe(true);
  await vi.advanceTimersByTimeAsync(201);
  await queue.run(
    () => c.browserChanged(),
    (e) => c.failure(e),
  );
  expect(vi.mocked(capture).mock.calls.at(-1)![2].closedTabs.has(10)).toBe(true);
  expect(vi.mocked(capture).mock.calls.at(-1)![2].navigations.has(11)).toBe(true);
  c["remoteChanges"].note();
  await queue.run(
    () => c.socketMessage("changed"),
    (e) => c.failure(e),
  );
  await c.reconnect();
  expect(c.flush).toHaveBeenCalled();
  expect(queue.pending).toBe(0);
});

it("re-enters hydration when a browser race interrupted startup with an open socket", async () => {
  const c = setup();
  await c.connect();
  Socket.all[0]!.open();
  c.lifecycle = "FETCHING_CANONICAL_STATE";
  c.failure(new BrowserRuntimeRaceError());
  await c.reconnect();
  expect(c.lifecycle).toBe("LIVE");
  expect(c["halted"]).toBe(false);
  c.events.changed(0);
  await c.browserChanged();
  expect(capture).toHaveBeenCalled();
});

it.each(["worker restart", "extension reload", "browser restart"])(
  "loads durable mapping and replaces stale intent on %s",
  async (kind) => {
    const previous = setup();
    const state = structuredClone(previous["local"]!);
    state.intent = {
      ...emptyWorkspace(),
      windows: { stale: { id: "stale", order: 0, changed: 0 } },
    };
    vi.mocked(vault.loadState).mockResolvedValue(state);
    vi.mocked(vault.read).mockResolvedValue({});
    if (kind === "browser restart") vi.mocked(sessionId).mockResolvedValue("new-session");
    const c = setup();
    c["local"] = undefined;
    c.lifecycle = "UNINITIALIZED";
    const loading = c.load();
    await vi.advanceTimersByTimeAsync(500);
    await loading;
    expect(c["error"]).toBe("");
    expect(c.lifecycle).toBe("LIVE");
    expect(state.intent).toBeUndefined();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ windows: {} }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    Socket.all.at(-1)!.open();
    await c.reconnect();
    c.events.changed(0);
    await c.browserChanged();
    expect(capture).toHaveBeenCalled();
  },
);

it("keeps remote hints received during pull dirty and coalesces already acknowledged hints", async () => {
  const c = setup();
  await c.connect();
  Socket.all[0]!.open();
  const socket = Socket.all[0]!;
  socket.message("changed");
  const generation = c["remoteChanges"].snapshot();
  c.lifecycle = "RECONCILING";
  await c.socketMessage("changed");
  socket.message("changed");
  c["remoteChanges"].acknowledge(generation);
  expect(c["remoteChanges"].dirty).toBe(true);
  c.lifecycle = "LIVE";
  await c.browserChanged();
  expect(c.flush).toHaveBeenCalled();
  c["remoteChanges"].acknowledge(c["remoteChanges"].snapshot());
  vi.mocked(c.flush).mockClear();
  for (let i = 0; i < 30; i++) await c.socketMessage("changed");
  expect(c.flush).not.toHaveBeenCalled();
});

it("skips identical durable state writes but retries a rejected save", async () => {
  const c = setup();
  await c["persist"]();
  await c["persist"]();
  expect(vault.saveState).toHaveBeenCalledTimes(1);
  c["local"]!.paused = true;
  vi.mocked(vault.saveState).mockRejectedValueOnce(new Error("test storage failure"));
  await expect(c["persist"]()).rejects.toThrow();
  await c["persist"]();
  expect(vault.saveState).toHaveBeenCalledTimes(3);
});

it("does not busy-reschedule browser evidence while halted or waiting for hydration", () => {
  const c = setup();
  c.events.changed(0);
  expect(c.browserWorkPending).toBe(true);
  c.lifecycle = "FETCHING_CANONICAL_STATE";
  expect(c.browserWorkPending).toBe(false);
  c.lifecycle = "LIVE";
  c.failure(new Error("Signature mismatch"));
  expect(c.browserWorkPending).toBe(false);
  expect(c["halted"]).toBe(true);
});

it("retries an interrupted durable load on the next alarm without replacing identity", async () => {
  const c = setup();
  const state = c["local"]!;
  c["local"] = undefined;
  vi.mocked(vault.loadState)
    .mockRejectedValueOnce(new StorageInterruptedError(new DOMException("aborted", "AbortError")))
    .mockResolvedValue(state);
  vi.mocked(vault.read).mockResolvedValue({});
  await expect(c.load()).rejects.toBeInstanceOf(StorageInterruptedError);
  expect(c["loaded"]).toBe(false);
  expect(c["loadFailed"]).toBe(false);
  expect(chrome.alarms.create).toHaveBeenCalledWith("relay-reconnect", { when: 130_000 });
  await c.load();
  expect(c.lifecycle).toBe("LIVE");
  expect(c["halted"]).toBe(false);
  c.events.changed(0);
  await c.browserChanged();
  expect(capture).toHaveBeenCalled();
});
