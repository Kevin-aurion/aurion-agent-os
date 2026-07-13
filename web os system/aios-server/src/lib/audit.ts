import { ulid } from 'ulid';
import { prisma } from './db.js';

export async function audit(
  userId: string | null,
  action: string,
  entity: string,
  entityId: string,
  detail?: unknown,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { id: ulid(), userId, action, entity, entityId, detail: detail === undefined ? undefined : (detail as object) },
    });
  } catch {
    // auditing must never break the request path
  }
}
