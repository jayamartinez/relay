import { describe, expect, it, vi } from "vitest";
import {
  adjacentApprovalId,
  approvalPosition,
  badgeText,
  currentApproval,
  recoverApprovalActivity,
  SingleFlight,
} from "./approval-ui";
import { groupedCode } from "./ui";

const now = 1_000_000;
const approval = (id: string, expires = now + 60_000, sas = "419 882") => ({
  id,
  expires,
  requestedAt: expires - 590_000,
  sas,
  reviewing: true,
  ours: true,
});

describe("popup device approvals", () => {
  it("shows one current request with the canonical SAS and no redirect state", () => {
    const request = currentApproval([approval("one")], undefined, now);
    expect(request).toMatchObject({ id: "one", sas: "419 882", ours: true });
    expect(groupedCode(request!.sas!)).toBe("419 882");
  });

  it("keeps multiple requests distinct and navigable", () => {
    const requests = [approval("one"), approval("two")];
    expect(approvalPosition(requests, "one", now)).toEqual({ index: 0, total: 2 });
    expect(adjacentApprovalId(requests, "one", 1, now)).toBe("two");
    expect(currentApproval(requests, "two", now)?.id).toBe("two");
  });

  it("drops expired requests from selection and badge counts", () => {
    const requests = [approval("expired", now - 1), approval("valid")];
    expect(currentApproval(requests, "expired", now)?.id).toBe("valid");
    expect(badgeText(requests, now)).toBe("1");
    expect(badgeText([], now)).toBe("");
  });

  it("caps the toolbar badge at 9+", () => {
    expect(
      badgeText(
        Array.from({ length: 10 }, (_, index) => approval(String(index))),
        now,
      ),
    ).toBe("9+");
  });

  it("submits a double-clicked approval exactly once", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const approve = vi.fn(() => pending);
    const flight = new SingleFlight();
    const first = flight.run("approve:one", approve);
    const second = flight.run("approve:one", approve);
    expect(first).toBe(second);
    expect(approve).toHaveBeenCalledTimes(1);
    resolve();
    await first;
  });

  it("reflects cross-surface removal by selecting the next authoritative request", () => {
    const before = [approval("one"), approval("two")];
    expect(currentApproval(before, "one", now)?.id).toBe("one");
    expect(currentApproval([approval("two")], "one", now)?.id).toBe("two");
  });

  it("recovers in-flight approval and denial after a service-worker restart", () => {
    const base = {
      requestId: "one",
      deviceId: "device-one",
      status: "working" as const,
      startedAt: now - 1_000,
    };
    expect(
      recoverApprovalActivity(
        { ...base, action: "approve" },
        new Set(),
        new Set(["device-one"]),
        now,
      ).status,
    ).toBe("approved");
    expect(
      recoverApprovalActivity({ ...base, action: "deny" }, new Set(), new Set(), now).status,
    ).toBe("denied");
    expect(
      recoverApprovalActivity({ ...base, action: "approve" }, new Set(["one"]), new Set(), now),
    ).toMatchObject({ status: "failed", error: "Approval was interrupted. Try again." });
  });
});
