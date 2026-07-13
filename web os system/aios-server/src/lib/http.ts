// Uniform API envelope + typed error helper.
import type { FastifyReply } from 'fastify';

export type Ok<T> = { success: true; data: T };
export type Err = { success: false; error: { code: string; message: string; detail?: unknown } };

export function ok<T>(data: T): Ok<T> {
  return { success: true, data };
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
  }
}

export const errors = {
  unauthorized: (m = 'Unauthorized') => new ApiError(401, 'UNAUTHORIZED', m),
  forbidden: (m = 'Forbidden') => new ApiError(403, 'FORBIDDEN', m),
  notFound: (m = 'Not found') => new ApiError(404, 'NOT_FOUND', m),
  badRequest: (m = 'Bad request', detail?: unknown) => new ApiError(400, 'BAD_REQUEST', m, detail),
  conflict: (m = 'Conflict') => new ApiError(409, 'CONFLICT', m),
  notConfigured: (m = 'Integration not configured') => new ApiError(412, 'NOT_CONFIGURED', m),
  internal: (m = 'Internal error') => new ApiError(500, 'INTERNAL', m),
};

export function sendError(reply: FastifyReply, e: unknown) {
  if (e instanceof ApiError) {
    return reply.code(e.statusCode).send({
      success: false,
      error: { code: e.code, message: e.message, detail: e.detail },
    } satisfies Err);
  }
  const message = e instanceof Error ? e.message : String(e);
  return reply.code(500).send({ success: false, error: { code: 'INTERNAL', message } } satisfies Err);
}
