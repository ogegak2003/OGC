/** Optional text input: empty (after validation trimming) is stored as null. */
export function blankToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
