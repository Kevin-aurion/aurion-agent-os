/**
 * User-hub lifecycle events for DeviceTask transitions.
 * Private device WS registry is never mixed in — only hub.publish (user AWP).
 * Payload is intentionally minimal: ids + status only (no secrets/raw results).
 */
import { hub } from '../ws/hub.js';

export type DeviceTaskLifecycleTopic =
  | 'device.task.ack'
  | 'device.task.progress'
  | 'device.task.result'
  | 'device.task.cancel'
  | 'device.task.confirm'
  | 'device.task.reject'
  | 'device.task.create';

export interface DeviceTaskLifecyclePayload {
  taskId: string;
  deviceId: string;
  status: string;
  runId: string | null;
  agentId: string | null;
}

/** Safe subset of a DeviceTask row for user-hub events. */
export function deviceTaskLifecyclePayload(task: {
  id: string;
  deviceId: string;
  status: string;
  runId?: string | null;
  agentId?: string | null;
}): DeviceTaskLifecyclePayload {
  return {
    taskId: task.id,
    deviceId: task.deviceId,
    status: task.status,
    runId: task.runId ?? null,
    agentId: task.agentId ?? null,
  };
}

/**
 * Publish a public user-hub event. Callers must pass only lifecycle topics.
 * Does not touch publishToDevice / device connection registry.
 */
export function publishDeviceTaskLifecycle(
  topic: DeviceTaskLifecycleTopic,
  task: {
    id: string;
    deviceId: string;
    status: string;
    runId?: string | null;
    agentId?: string | null;
  },
): void {
  try {
    hub.publish(topic, deviceTaskLifecyclePayload(task));
  } catch {
    // Event fan-out must never fail the request path.
  }
}

/** Safe JSON projection of a DeviceTask for FDE list/get (no paths/tokens/raw secrets). */
export function toSafeDeviceTaskDto(task: {
  id: string;
  deviceId: string;
  agentId: string | null;
  runId: string | null;
  stepKey: string | null;
  kind: string;
  status: string;
  idempotencyKey: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  deadlineAt: Date | null;
  confirmationRequired: boolean;
  confirmationArtifactId: string | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  requestedByUserId: string | null;
  terminalAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // deliberately omit payload/result/error/progress bulk — list view is metadata-only
}) {
  return {
    id: task.id,
    deviceId: task.deviceId,
    agentId: task.agentId,
    runId: task.runId,
    stepKey: task.stepKey,
    kind: task.kind,
    status: task.status,
    idempotencyKey: task.idempotencyKey,
    hasLease: !!task.leaseId,
    leaseExpiresAt: task.leaseExpiresAt,
    deadlineAt: task.deadlineAt,
    confirmationRequired: task.confirmationRequired,
    confirmationArtifactId: task.confirmationArtifactId,
    confirmedAt: task.confirmedAt,
    confirmedBy: task.confirmedBy,
    requestedByUserId: task.requestedByUserId,
    terminalAt: task.terminalAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
