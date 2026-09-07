import {
  base64,
  controlHash,
  encryptEnvelope,
  identity,
  makeControl,
  randomKey,
  wrapRoot,
} from "@relay/crypto";
import {
  controlBody,
  type Envelope,
  emptyWorkspace,
  type Operation,
  type SyncReply,
} from "@relay/protocol";
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
type TestFixture = Awaited<ReturnType<typeof fixture>>;
interface PersistedTestState {
  control?: { epoch: number };
  canonical: { revision: number };
  snapshotRequired?: { epoch: number; generation: number };
}
async function nextEpochTransition(
  f: TestFixture,
  previous: TestFixture["control"],
  previousRoot: Uint8Array<ArrayBuffer>,
) {
  const epoch = previous.epoch + 1;
  const joining = await identity();
  const added = await makeControl(
    {
      ...controlBody(previous),
      generation: previous.generation + 1,
      previous: await controlHash(previous),
      actor: f.device.device.id,
      members: [f.device.device, joining.device],
      boxes: {
        ...previous.boxes,
        [joining.device.id]: await wrapRoot(
          previousRoot,
          joining.device.exchange,
          f.handle,
          epoch - 1,
          joining.device.id,
        ),
      },
    },
    f.device.signing,
  );
  const root = randomKey();
  const control = await makeControl(
    {
      ...controlBody(added),
      generation: added.generation + 1,
      previous: await controlHash(added),
      actor: f.device.device.id,
      epoch,
      members: [f.device.device],
      boxes: {
        [f.device.device.id]: await wrapRoot(
          root,
          f.device.device.exchange,
          f.handle,
          epoch,
          f.device.device.id,
        ),
        recovery: await wrapRoot(root, added.recovery.exchange, f.handle, epoch, "recovery"),
      },
    },
    f.device.signing,
  );
  const snapshot = await encryptEnvelope(
    root,
    f.device.signing,
    { ...f.snapshot.header, epoch, base: f.workspace.revision },
    f.workspace,
  );
  const operation: Operation = {
    id: `epoch-${epoch}-operation`,
    sender: f.device.device.id,
    sequence: 1,
    base: f.workspace.revision,
    changes: [{ type: "window-create", id: `epoch-${epoch}-window`, order: 0 }],
  };
  const envelope = await encryptEnvelope(
    root,
    f.device.signing,
    { ...snapshot.header, sequence: operation.sequence, base: operation.base, type: "operation" },
    operation,
  );
  return { added, control, root, snapshot, envelope };
}
async function epochTwoTransition(f: TestFixture) {
  return nextEpochTransition(f, f.control, f.root);
}
function configureEpochOne(c: Controller, f: TestFixture) {
  Object.assign(c["local"]!, {
    handle: f.handle,
    device: f.device.device,
    root: base64(f.root),
    control: f.control,
    canonical: f.workspace,
  });
  c["signing"] = f.device.signing;
  c["exchange"] = f.device.exchange;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.mocked(vault.saveState).mockResolvedValue();
  vi.mocked(vault.loadState).mockResolvedValue(undefined);
  vi.mocked(vault.read).mockResolvedValue(undefined);
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

  it("accepts a complete under-limit legacy sync response", async () => {
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
      revision: 0,
      sequence: 0,
      pending: [],
      presence: {},
    })) as (typeof c)["auth"];
    await expect(c.pull()).resolves.toBeUndefined();
  });

  it("validates paged controls before decrypting a new-epoch snapshot and operation", async () => {
    const f = await fixture();
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    const joining = await identity();
    const added = await makeControl(
      {
        ...controlBody(f.control),
        generation: 1,
        previous: await controlHash(f.control),
        actor: f.device.device.id,
        members: [f.device.device, joining.device],
        boxes: {
          ...f.control.boxes,
          [joining.device.id]: await wrapRoot(
            f.root,
            joining.device.exchange,
            f.handle,
            1,
            joining.device.id,
          ),
        },
      },
      f.device.signing,
    );
    const rotatedRoot = randomKey();
    const rotated = await makeControl(
      {
        ...controlBody(added),
        generation: 2,
        previous: await controlHash(added),
        actor: f.device.device.id,
        epoch: 2,
        members: [f.device.device],
        boxes: {
          [f.device.device.id]: await wrapRoot(
            rotatedRoot,
            f.device.device.exchange,
            f.handle,
            2,
            f.device.device.id,
          ),
          recovery: await wrapRoot(rotatedRoot, added.recovery.exchange, f.handle, 2, "recovery"),
        },
      },
      f.device.signing,
    );
    const snapshot = await encryptEnvelope(
      rotatedRoot,
      f.device.signing,
      { ...f.snapshot.header, epoch: 2 },
      f.workspace,
    );
    const operation: Operation = {
      id: "epoch-two",
      sender: f.device.device.id,
      sequence: 1,
      base: 0,
      changes: [{ type: "window-create", id: "epoch-window", order: 0 }],
    };
    const envelope = await encryptEnvelope(
      rotatedRoot,
      f.device.signing,
      { ...snapshot.header, sequence: 1, base: 0, type: "operation" },
      operation,
    );
    Object.assign(c["local"]!, {
      handle: f.handle,
      device: f.device.device,
      root: base64(f.root),
      control: f.control,
      canonical: f.workspace,
    });
    c["signing"] = f.device.signing;
    c["exchange"] = f.device.exchange;
    c["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      if (payload.generation === 0)
        return {
          kind: "control",
          chain: [added],
          fromGeneration: 0,
          nextGeneration: 1,
          more: true,
        };
      if (payload.generation === 1)
        return {
          kind: "control",
          chain: [rotated],
          fromGeneration: 1,
          nextGeneration: 2,
          more: false,
        };
      expect(payload).toMatchObject({ generation: 2, force: true, pagination: true });
      return {
        kind: "workspace",
        generation: 2,
        chain: [],
        snapshot,
        operations: [{ revision: 1, envelope }],
        from: 0,
        next: 1,
        more: false,
        revision: 1,
        sequence: 1,
        pending: [],
        presence: {},
      };
    }) as (typeof c)["auth"];

    await c.pull();

    expect(c["local"]!.control?.epoch).toBe(2);
    expect(c["local"]!.canonical.revision).toBe(1);
    expect(c["local"]!.canonical.windows["epoch-window"]).toBeDefined();
  });

  it("requires an epoch snapshot after restart when control persistence completed first", async () => {
    const f = await fixture();
    const transition = await epochTwoTransition(f);
    const persisted: PersistedTestState[] = [];
    vi.mocked(vault.saveState).mockImplementation(async (state) => {
      persisted.push(structuredClone(state) as PersistedTestState);
    });

    const initial = setup();
    vi.mocked(initial.pull).mockRestore();
    configureEpochOne(initial, f);
    initial["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      if (payload.generation === 0)
        return {
          kind: "control",
          chain: [transition.added, transition.control],
          fromGeneration: 0,
          nextGeneration: 2,
          more: false,
        };
      throw new Error("simulated worker termination");
    }) as (typeof initial)["auth"];

    await expect(initial.pull()).rejects.toThrow("simulated worker termination");
    const afterControl = persisted.at(-1)!;
    expect(afterControl.control?.epoch).toBe(2);
    expect(afterControl.canonical.revision).toBe(f.workspace.revision);
    expect(afterControl.snapshotRequired).toEqual({ epoch: 2, generation: 2 });

    const resumed = setup();
    vi.mocked(resumed.pull).mockRestore();
    resumed["local"] = structuredClone(afterControl) as (typeof resumed)["local"];
    resumed["signing"] = f.device.signing;
    resumed["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      expect(payload).toMatchObject({
        since: f.workspace.revision,
        generation: 2,
        force: true,
        pagination: true,
      });
      return {
        kind: "workspace",
        generation: 2,
        chain: [],
        snapshot: transition.snapshot,
        operations: [{ revision: f.workspace.revision + 1, envelope: transition.envelope }],
        from: f.workspace.revision,
        next: f.workspace.revision + 1,
        more: false,
        revision: f.workspace.revision + 1,
        sequence: 1,
        pending: [],
        presence: {},
      };
    }) as (typeof resumed)["auth"];

    await resumed.pull();

    expect(resumed["local"]!.canonical.windows["epoch-2-window"]).toBeDefined();
    expect(
      persisted.some(
        (state) =>
          state.control?.epoch === 2 &&
          state.canonical.revision === f.workspace.revision &&
          state.snapshotRequired === undefined,
      ),
    ).toBe(false);
    const afterSnapshot = persisted.at(-1)!;
    expect(afterSnapshot.canonical.revision).toBe(f.workspace.revision + 1);
    expect(afterSnapshot.snapshotRequired).toBeUndefined();

    const restarted = setup();
    vi.mocked(restarted.pull).mockRestore();
    restarted["local"] = structuredClone(afterSnapshot) as (typeof restarted)["local"];
    restarted["signing"] = f.device.signing;
    restarted["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      expect(payload).toMatchObject({ generation: 2, force: false, pagination: true });
      return {
        kind: "workspace",
        generation: 2,
        chain: [],
        operations: [],
        from: f.workspace.revision + 1,
        next: f.workspace.revision + 1,
        more: false,
        revision: f.workspace.revision + 1,
        sequence: 1,
        pending: [],
        presence: {},
      };
    }) as (typeof restarted)["auth"];
    await restarted.pull();
  });

  it("retains the epoch snapshot requirement when the forced fetch fails", async () => {
    const f = await fixture();
    const transition = await epochTwoTransition(f);
    const persisted: PersistedTestState[] = [];
    vi.mocked(vault.saveState).mockImplementation(async (state) => {
      persisted.push(structuredClone(state) as PersistedTestState);
    });
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    configureEpochOne(c, f);
    c["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      if (payload.generation === 0)
        return {
          kind: "control",
          chain: [transition.added, transition.control],
          fromGeneration: 0,
          nextGeneration: 2,
          more: false,
        };
      expect(payload).toMatchObject({ generation: 2, force: true });
      throw new ApiError(503, "UNAVAILABLE", "snapshot fetch failed");
    }) as (typeof c)["auth"];

    await expect(c.pull()).rejects.toThrow("UNAVAILABLE");
    expect(c["local"]!.snapshotRequired).toEqual({ epoch: 2, generation: 2 });
    expect(persisted.at(-1)!.snapshotRequired).toEqual({ epoch: 2, generation: 2 });
  });

  it("retains the epoch snapshot requirement when snapshot persistence fails", async () => {
    const f = await fixture();
    const transition = await epochTwoTransition(f);
    let persisted!: PersistedTestState;
    let writes = 0;
    vi.mocked(vault.saveState).mockImplementation(async (state) => {
      if (writes++ > 0)
        throw new StorageInterruptedError(new Error("simulated storage interruption"));
      persisted = structuredClone(state) as PersistedTestState;
    });
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    configureEpochOne(c, f);
    c["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      if (payload.generation === 0)
        return {
          kind: "control",
          chain: [transition.added, transition.control],
          fromGeneration: 0,
          nextGeneration: 2,
          more: false,
        };
      return {
        kind: "workspace",
        generation: 2,
        chain: [],
        snapshot: transition.snapshot,
        operations: [{ revision: 1, envelope: transition.envelope }],
        from: 0,
        next: 1,
        more: false,
        revision: 1,
        sequence: 1,
        pending: [],
        presence: {},
      };
    }) as (typeof c)["auth"];

    await expect(c.pull()).rejects.toBeInstanceOf(StorageInterruptedError);
    expect(persisted.snapshotRequired).toEqual({ epoch: 2, generation: 2 });
    expect(c["local"]!.snapshotRequired).toEqual({ epoch: 2, generation: 2 });
  });

  it("rejects a wrong-epoch snapshot without applying its workspace operations", async () => {
    const f = await fixture();
    const transition = await epochTwoTransition(f);
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    configureEpochOne(c, f);
    c["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      if (payload.generation === 0)
        return {
          kind: "control",
          chain: [transition.added, transition.control],
          fromGeneration: 0,
          nextGeneration: 2,
          more: false,
        };
      expect(payload).toMatchObject({ generation: 2, force: true });
      return {
        kind: "workspace",
        generation: 2,
        chain: [],
        snapshot: f.snapshot,
        operations: [{ revision: 1, envelope: transition.envelope }],
        from: 0,
        next: 1,
        more: false,
        revision: 1,
        sequence: 1,
        pending: [],
        presence: {},
      };
    }) as (typeof c)["auth"];

    await expect(c.pull()).rejects.toThrow("Unexpected epoch snapshot.");
    expect(c["local"]!.snapshotRequired).toEqual({ epoch: 2, generation: 2 });
    expect(c["local"]!.canonical.windows["epoch-2-window"]).toBeUndefined();
  });

  it("keeps the latest epoch requirement when control catch-up crosses multiple rotations", async () => {
    const f = await fixture();
    const epochTwo = await epochTwoTransition(f);
    const epochThree = await nextEpochTransition(f, epochTwo.control, epochTwo.root);
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    configureEpochOne(c, f);
    c["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      if (payload.generation === 0)
        return {
          kind: "control",
          chain: [epochTwo.added, epochTwo.control, epochThree.added, epochThree.control],
          fromGeneration: 0,
          nextGeneration: 4,
          more: false,
        };
      expect(payload).toMatchObject({ generation: 4, force: true });
      return {
        kind: "workspace",
        generation: 4,
        chain: [],
        snapshot: epochTwo.snapshot,
        operations: [{ revision: 1, envelope: epochThree.envelope }],
        from: 0,
        next: 1,
        more: false,
        revision: 1,
        sequence: 1,
        pending: [],
        presence: {},
      };
    }) as (typeof c)["auth"];

    await expect(c.pull()).rejects.toThrow("Unexpected epoch snapshot.");
    expect(c["local"]!.snapshotRequired).toEqual({ epoch: 3, generation: 4 });
    expect(c["local"]!.canonical.windows["epoch-3-window"]).toBeUndefined();
  });

  it("reloads persisted state into a new controller and resumes a workspace page", async () => {
    const f = await fixture();
    const queued: Operation = {
      id: "queued-after-restart",
      sender: f.device.device.id,
      sequence: 3,
      base: 0,
      changes: [{ type: "window-create", id: "queued-window", order: 0 }],
    };
    const operations: Operation[] = [
      {
        id: "before-restart",
        sender: f.device.device.id,
        sequence: 1,
        base: 0,
        changes: [{ type: "window-create", id: "first-window", order: 0 }],
      },
      {
        id: "after-restart",
        sender: f.device.device.id,
        sequence: 2,
        base: 1,
        changes: [{ type: "window-delete", id: "first-window" }],
      },
    ];
    const envelopes = await Promise.all(
      operations.map((operation) =>
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
        ),
      ),
    );
    let persisted: unknown;
    vi.mocked(vault.saveState).mockImplementation(async (state) => {
      persisted = structuredClone(state);
    });
    const initial = setup();
    vi.mocked(initial.pull).mockRestore();
    Object.assign(initial["local"]!, {
      handle: f.handle,
      device: f.device.device,
      root: base64(f.root),
      control: f.control,
      canonical: f.workspace,
      queue: [{ sequence: 3, operation: queued }],
      nextSequence: 4,
    });
    initial["signing"] = f.device.signing;
    initial["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      if (payload.since === 0)
        return {
          kind: "workspace",
          generation: 0,
          chain: [],
          operations: [{ revision: 1, envelope: envelopes[0]! }],
          from: 0,
          next: 1,
          more: true,
          revision: 2,
          sequence: 2,
          pending: [],
          presence: {},
        };
      throw new Error("simulated worker termination");
    }) as (typeof initial)["auth"];
    await expect(initial.pull()).rejects.toThrow("simulated worker termination");
    expect((persisted as { canonical: { revision: number } }).canonical.revision).toBe(1);

    const resumed = setup();
    vi.mocked(resumed.pull).mockRestore();
    resumed["local"] = structuredClone(persisted) as (typeof resumed)["local"];
    resumed["signing"] = f.device.signing;
    resumed["auth"] = vi.fn(async (_action: string, payload: Record<string, unknown>) => {
      expect(payload).toMatchObject({ since: 1, generation: 0, pagination: true });
      return {
        kind: "workspace",
        generation: 0,
        chain: [],
        operations: [{ revision: 2, envelope: envelopes[1]! }],
        from: 1,
        next: 2,
        more: false,
        revision: 2,
        sequence: 2,
        pending: [],
        presence: {},
      };
    }) as (typeof resumed)["auth"];

    await resumed.pull();

    expect(resumed["local"]!.canonical.revision).toBe(2);
    expect(resumed["local"]!.canonical.windows).toEqual({});
    expect(resumed["local"]!.queue).toEqual([{ sequence: 3, operation: queued }]);
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

describe("durable local intent recovery", () => {
  const workspace = (url: string) => ({
    ...emptyWorkspace(),
    revision: 435,
    windows: { w: { id: "w", order: 0, changed: 1 } },
    tabs: {
      t: {
        id: "t",
        window: "w",
        index: 0,
        pinned: false,
        kind: "web" as const,
        url,
        changed: 1,
        writer: "remote",
        source: "remote",
      },
    },
  });

  it("does not journal or retire navigation intent for an unrelated tab move", async () => {
    const c = setup();
    const s = c["local"]!;
    s.canonical = workspace("https://remote.example/");
    s.mapping.observed = workspace("https://local.example/");
    s.mapping.freshness = {
      generation: 1,
      intents: {
        t: {
          generation: 1,
          kind: "navigate",
          url: "https://local.example/",
          canonicalRevision: 435,
        },
      },
    };

    await c["enqueue"]([{ type: "tab-move", id: "t", window: "w", index: 0 }]);
    expect(s.mapping.freshness.intents.t!.journaled).toBeUndefined();
    s.queue = [];
    s.mapping.freshness.intents.t!.journaled = true; // Legacy persisted state.
    c["settleLocalIntents"]();
    expect(s.mapping.freshness.intents.t).toBeDefined();

    await c["journalDurableIntents"]();
    expect(s.queue.at(-1)!.operation.changes).toEqual([
      expect.objectContaining({ type: "tab-navigate", id: "t", url: "https://local.example/" }),
    ]);
  });

  it("repairs a protected navigation with a create when its canonical tab was deleted", async () => {
    const c = setup();
    const s = c["local"]!;
    const local = workspace("https://local.example/");
    s.canonical = { ...local, tabs: {} };
    s.mapping.observed = local;
    s.mapping.freshness = {
      generation: 1,
      intents: {
        t: {
          generation: 1,
          kind: "navigate",
          url: "https://local.example/",
          canonicalRevision: 435,
          journaled: true,
        },
      },
    };
    s.queue = [
      {
        sequence: 1,
        operation: {
          id: "ignored-navigation",
          sender: s.device.id,
          sequence: 1,
          base: 435,
          changes: [
            {
              type: "tab-navigate",
              id: "t",
              kind: "web",
              url: "https://local.example/",
              source: s.device.id,
            },
          ],
        },
      },
    ];
    s.nextSequence = 2;

    await c["journalDurableIntents"]();

    expect(s.queue.at(-1)!.operation.changes).toEqual([
      expect.objectContaining({
        type: "tab-create",
        tab: expect.objectContaining({ id: "t", url: "https://local.example/" }),
      }),
    ]);
  });

  it("journals and settles a protected new-tab navigation using its canonical key", async () => {
    const c = setup();
    const s = c["local"]!;
    s.canonical = workspace("https://remote.example/");
    s.mapping = {
      session: "session",
      windows: { 1: "w" },
      tabs: { 9: "t" },
      expected: [],
      observed: workspace("https://remote.example/"),
    };

    c["recordNavigationIntent"](9, "chrome://newtab/");
    await c["journalDurableIntents"]();

    expect(s.queue.at(-1)!.operation.changes).toEqual([
      { type: "tab-navigate", id: "t", kind: "newtab", source: s.device.id },
    ]);
    expect(s.mapping.freshness?.intents.t?.journaled).toBe(true);
    s.queue = [];
    s.canonical.tabs.t = { ...s.canonical.tabs.t!, kind: "newtab" };
    delete s.canonical.tabs.t.url;
    c["settleLocalIntents"]();
    expect(s.mapping.freshness?.intents.t).toBeUndefined();
  });

  it("pushes a persisted local intent before recovery reconciliation, then reaches Live", async () => {
    const c = setup();
    const s = c["local"]!;
    const remote = workspace("https://remote.example/");
    const local = workspace("https://local.example/");
    s.canonical = remote;
    s.mapping = {
      session: "session",
      windows: { 1: "w" },
      tabs: { 9: "t" },
      expected: [],
      observed: local,
      freshness: {
        generation: 4,
        intents: {
          t: {
            generation: 4,
            kind: "navigate",
            url: "https://local.example/",
            canonicalRevision: 435,
            journaled: true,
          },
        },
      },
    };
    s.queue = [
      {
        sequence: 4,
        operation: {
          id: "move",
          sender: s.device.id,
          sequence: 4,
          base: 435,
          changes: [{ type: "tab-move", id: "t", window: "w", index: 0 }],
        },
      },
    ];
    s.nextSequence = 5;
    const persisted = structuredClone(s);
    c["local"] = undefined;
    c.lifecycle = "UNINITIALIZED";
    vi.mocked(vault.loadState).mockResolvedValue(persisted);
    vi.mocked(vault.read).mockResolvedValue({});
    const order: string[] = [];
    vi.mocked(c.pull).mockImplementation(async () => {
      order.push("pull");
    });
    vi.mocked(c.flush).mockImplementation(async (recovering = false) => {
      if (!recovering) return;
      expect(recovering).toBe(true);
      expect(c.lifecycle).toBe("RECONCILING");
      await c["journalDurableIntents"]();
      const active = c["local"]!;
      expect(active.queue.flatMap((entry) => entry.operation.changes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tab-move", id: "t" }),
          expect.objectContaining({ type: "tab-navigate", id: "t", url: "https://local.example/" }),
        ]),
      );
      order.push("flush");
      active.canonical = local;
      active.queue = [];
      c["settleLocalIntents"]();
    });
    vi.mocked(reconcile).mockImplementation(async (target, mapping) => {
      order.push("reconcile");
      expect(target.tabs.t!.url).toBe("https://local.example/");
      return { ...mapping, observed: target };
    });
    vi.mocked(browserWindows).mockResolvedValue([
      {
        local: 1,
        tabs: [
          {
            local: 9,
            window: 1,
            index: 0,
            pinned: false,
            incognito: false,
            url: "https://local.example/",
          },
        ],
      },
    ]);

    await c.load();

    expect(order.indexOf("flush")).toBeGreaterThan(order.indexOf("pull"));
    expect(order.indexOf("reconcile")).toBeGreaterThan(order.indexOf("flush"));
    expect(c["local"]!.mapping.freshness?.intents.t).toBeUndefined();
    expect(c.lifecycle).toBe("LIVE");
  });

  it("converges repeated live socket recovery attempts before pull-driven reconciliation can block its queue", async () => {
    const f = await fixture();
    const c = setup();
    vi.mocked(c.pull).mockRestore();
    vi.mocked(c.flush).mockRestore();
    configureEpochOne(c, f);
    const s = c["local"]!;
    const remote = workspace("https://remote.example/");
    const local = workspace("https://local.example/");
    s.canonical = remote;
    s.mapping = {
      session: "session",
      windows: { 1: "w" },
      tabs: { 9: "t" },
      expected: [],
      observed: local,
      freshness: {
        generation: 4,
        intents: {
          t: {
            generation: 4,
            kind: "navigate",
            url: "https://local.example/",
            canonicalRevision: 435,
            journaled: true,
          },
        },
      },
    };
    s.queue = [
      {
        sequence: 1,
        operation: {
          id: "move",
          sender: s.device.id,
          sequence: 1,
          base: 435,
          changes: [{ type: "tab-move", id: "t", window: "w", index: 0 }],
        },
      },
    ];
    s.nextSequence = 2;
    c["lastCheckpoint"] = 435;
    const accepted: Array<{ revision: number; envelope: Envelope }> = [];
    let failNextPush = true;
    c["auth"] = vi.fn(async (action: string, payload: Record<string, unknown>) => {
      if (action === "sync") {
        const since = payload.since as number;
        const revision = 435 + accepted.length;
        return {
          control: f.control,
          chain: [],
          operations: accepted.filter((row) => row.revision > since),
          from: since,
          next: revision,
          more: false,
          revision,
          sequence: accepted.length,
          pending: [],
          presence: {},
        };
      }
      if (action === "push") {
        if (failNextPush) {
          failNextPush = false;
          throw new ApiError(0, "offline");
        }
        accepted.push({
          revision: 435 + accepted.length + 1,
          envelope: payload.envelope as Envelope,
        });
        return { revision: 435 + accepted.length };
      }
      if (action === "socket-ticket") return { ticket: "test" };
      throw new Error(`Unexpected action: ${action}`);
    }) as (typeof c)["auth"];
    vi.mocked(reconcile).mockImplementation(
      async (target, mapping, _source, _persist, allowed = () => true) => {
        if (!allowed(target.tabs.t, "navigate")) throw new BrowserRuntimeRaceError();
        return { ...mapping, observed: target };
      },
    );
    vi.mocked(browserWindows).mockResolvedValue([
      {
        local: 1,
        tabs: [
          {
            local: 9,
            window: 1,
            index: 0,
            pinned: false,
            incognito: false,
            url: "https://local.example/",
          },
        ],
      },
    ]);

    const firstFailure = await c.connect().catch((error: unknown) => error);
    c.failure(firstFailure);
    expect(firstFailure).toBeInstanceOf(ApiError);
    expect(accepted).toHaveLength(0);
    expect(s.queue).toHaveLength(2);
    expect(s.mapping.freshness?.intents.t).toBeDefined();

    await c.connect();

    expect(accepted).toHaveLength(2);
    expect(s.queue).toEqual([]);
    expect(s.canonical.tabs.t?.url).toBe("https://local.example/");
    expect(s.mapping.freshness?.intents.t).toBeUndefined();
    expect(c.lifecycle).toBe("LIVE");
  });

  it("repairs and retires a durable delete intent only after canonical deletion", async () => {
    const c = setup();
    const s = c["local"]!;
    s.canonical = workspace("https://remote.example/");
    s.mapping.freshness = {
      generation: 1,
      intents: { t: { generation: 1, kind: "delete", canonicalRevision: 435, journaled: true } },
    };

    await c["journalDurableIntents"]();
    expect(s.queue.at(-1)!.operation.changes).toEqual([{ type: "tab-delete", id: "t" }]);
    s.queue = [];
    c["settleLocalIntents"]();
    expect(s.mapping.freshness.intents.t).toBeDefined();
    delete s.canonical.tabs.t;
    c["settleLocalIntents"]();
    expect(s.mapping.freshness.intents.t).toBeUndefined();
  });

  it("validates by pulling before a recovery push and preserves failed work", async () => {
    const f = await fixture();
    const c = setup();
    configureEpochOne(c, f);
    const s = c["local"]!;
    s.queue = [
      {
        sequence: 1,
        operation: {
          id: "local-navigation",
          sender: s.device.id,
          sequence: 1,
          base: s.canonical.revision,
          changes: [
            {
              type: "tab-navigate",
              id: Object.keys(s.canonical.tabs)[0]!,
              kind: "web",
              url: "https://local.example/",
              source: s.device.id,
            },
          ],
        },
      },
    ];
    c.lifecycle = "RECONCILING";
    vi.mocked(c.flush).mockRestore();
    const order: string[] = [];
    vi.mocked(c.pull).mockImplementation(async () => {
      order.push("pull");
    });
    c["auth"] = vi.fn(async (action: string) => {
      if (action === "push") {
        order.push("push");
        throw new ApiError(0, "offline");
      }
      throw new Error(`Unexpected action: ${action}`);
    }) as (typeof c)["auth"];

    await expect(c.flush(true)).rejects.toThrow("offline");
    expect(order).toEqual(["pull", "push"]);
    expect(s.queue).toHaveLength(1);
  });
});
