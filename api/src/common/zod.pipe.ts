import { PipeTransform } from '@nestjs/common';
import { ZodTypeAny, z } from 'zod';
import { isValidDate } from './dates';
import { badRequest } from './errors';

/** Validates a body / query / param against a zod schema and returns the parsed value. */
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw badRequest('VALIDATION', 'Some fields are invalid', {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

export const zodPipe = <S extends ZodTypeAny>(schema: S) => new ZodPipe(schema);

// Reusable field schemas
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(
  isValidDate,
  'Not a real calendar date',
);
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
export const uuid = z.string().uuid();
