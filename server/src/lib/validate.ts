import type { RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError } from './errors';

type Part = 'params' | 'query' | 'body';
type Schemas = Partial<Record<Part, ZodTypeAny>>;

/**
 * Express middleware that validates and normalises request parts with Zod.
 * Parsed values are stored on res.locals.input.{params,query,body} so that
 * routes only ever see typed, sanitised data. (Express 5 makes req.query
 * read-only, so the originals cannot be overwritten.)
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, res, next) => {
    const input: Partial<Record<Part, unknown>> = {};
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        const summary = result.error.issues
          .map((i) => `${i.path.join('.') || part} ${i.message}`)
          .join('; ');
        return next(
          new AppError(400, 'VALIDATION_ERROR', `Invalid ${part}: ${summary}`, result.error.flatten()),
        );
      }
      input[part] = result.data;
    }
    res.locals.input = input;
    next();
  };
}

/** Typed accessor for the validated input stored by validate(). */
export function input<T>(res: Response, part: Part): T {
  return (res.locals.input as Record<Part, unknown>)[part] as T;
}
