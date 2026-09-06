// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Status } from "./controller";

export type Approval = Status["approvals"][number];
export interface ApprovalActivity {
  requestId: string;
  deviceId: string;
  action: "approve" | "deny";
  status: "working" | "approved" | "denied" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export function currentApproval(
  approvals: Approval[],
  selectedId: string | undefined,
  now = Date.now(),
) {
  const valid = approvals.filter((approval) => approval.expires > now);
  return valid.find((approval) => approval.id === selectedId) ?? valid[0];
}

export function approvalPosition(approvals: Approval[], requestId: string, now = Date.now()) {
  const valid = approvals.filter((approval) => approval.expires > now);
  return { index: valid.findIndex((approval) => approval.id === requestId), total: valid.length };
}

export function adjacentApprovalId(
  approvals: Approval[],
  requestId: string,
  offset: -1 | 1,
  now = Date.now(),
) {
  const valid = approvals.filter((approval) => approval.expires > now);
  const index = valid.findIndex((approval) => approval.id === requestId);
  if (index < 0 || valid.length < 2) return undefined;
  return valid[(index + offset + valid.length) % valid.length]?.id;
}

export function badgeText(approvals: Pick<Approval, "expires">[], now = Date.now()) {
  const count = approvals.filter((approval) => approval.expires > now).length;
  return count > 9 ? "9+" : count ? String(count) : "";
}

export function recoverApprovalActivity(
  activity: ApprovalActivity,
  pendingRequestIds: Set<string>,
  authorizedDeviceIds: Set<string>,
  now = Date.now(),
): ApprovalActivity {
  if (activity.status === "approved" || activity.status === "denied") return activity;
  if (pendingRequestIds.has(activity.requestId))
    return activity.status === "failed"
      ? activity
      : {
          ...activity,
          status: "failed",
          finishedAt: now,
          error: "Approval was interrupted. Try again.",
        };
  if (activity.action === "deny")
    return { ...activity, status: "denied", finishedAt: now, error: undefined };
  const approved = authorizedDeviceIds.has(activity.deviceId);
  return {
    ...activity,
    status: approved ? "approved" : "failed",
    finishedAt: now,
    error: approved ? undefined : "Request no longer exists.",
  };
}

export class SingleFlight {
  private running = new Map<string, Promise<unknown>>();

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const active = this.running.get(key);
    if (active) return active as Promise<T>;
    const task = action().finally(() => this.running.delete(key));
    this.running.set(key, task);
    return task;
  }

  has(key: string) {
    return this.running.has(key);
  }
}
