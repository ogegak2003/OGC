import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const pipe = new ZodValidationPipe(z.strictObject({ name: z.string().min(2), age: z.number() }));

describe('ZodValidationPipe', () => {
  it('returns parsed data', () => {
    expect(pipe.transform({ name: 'Ada', age: 36 })).toEqual({ name: 'Ada', age: 36 });
  });

  it('rejects invalid input with a 400 VALIDATION_FAILED error', () => {
    try {
      pipe.transform({ name: 'secret-value-x', age: 'x' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      expect(http.getStatus()).toBe(400);
      expect(http.getResponse()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(JSON.stringify(http.getResponse())).not.toContain('secret-value-x');
    }
  });

  it('rejects unknown keys and missing bodies', () => {
    expect(() => pipe.transform({ name: 'Ada', age: 1, admin: true })).toThrow(HttpException);
    expect(() => pipe.transform(undefined)).toThrow(HttpException);
  });
});
