import { HttpStatus } from '@nestjs/common';
import type { Page } from '@ogc/types';
import { ApiException } from './errors.js';

/**
 * Keyset (cursor) pagination over UUIDv7 row IDs, newest first. UUIDv7 sorts by
 * creation time, so `id < cursor ORDER BY id DESC` is stable under concurrent
 * inserts and uses the `(owner, id)` indexes — no OFFSET scans.
 *
 * Cursors are opaque to clients (base64url of the row ID) and are validated on input.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(id)) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'cursor: Invalid cursor');
  }
  return id;
}

/** Turns `limit + 1` fetched rows into a page, using the extra row only to detect more data. */
export function toPage<Row extends { id: string }, Item>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Item,
): Page<Item> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}
