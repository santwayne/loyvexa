export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, msg, details) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Unauthorized') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code, msg, details) => new AppError(409, code, msg, details);

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse with a zod schema or throw a 400. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('VALIDATION_ERROR', 'Invalid input', r.error.flatten());
  return r.data;
}
