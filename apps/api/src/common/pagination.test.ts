import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, toPage } from './pagination.js';

describe('cursor pagination', () => {
  it('round-trips row IDs through opaque cursors', () => {
    const id = randomUUID();
    const cursor = encodeCursor(id);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toBe(id);
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('rejects cursors that do not decode to a row ID', () => {
    for (const bad of ['abc', encodeCursor('1 OR 1=1'), encodeCursor('../../etc')]) {
      expect(() => decodeCursor(bad)).toThrow(HttpException);
    }
  });

  it('builds pages using one extra row to detect more data', () => {
    const rows = Array.from({ length: 3 }, () => ({ id: randomUUID() }));
    expect(toPage(rows, 2, (r) => r.id)).toEqual({
      items: [rows[0]?.id, rows[1]?.id],
      nextCursor: encodeCursor(rows[1]?.id ?? ''),
    });
    expect(toPage(rows, 3, (r) => r.id).nextCursor).toBeNull();
  });
});
