import { describe, expect, it } from 'vitest';
import { secondsUntilAllowed } from './mls-resync-limits.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const TEN_MINUTES = 10 * 60_000;

describe('secondsUntilAllowed', () => {
  it('is zero while the window has room', () => {
    expect(secondsUntilAllowed([], 3, TEN_MINUTES, NOW)).toBe(0);
    expect(secondsUntilAllowed([ago(60), ago(30)], 3, TEN_MINUTES, NOW)).toBe(0);
  });

  it('waits until the oldest counted resync leaves a full window', () => {
    // Oldest 9 minutes ago: it leaves the 10-minute window in 60 s.
    expect(secondsUntilAllowed([ago(540), ago(300), ago(60)], 3, TEN_MINUTES, NOW)).toBe(60);
  });

  it('with more than the limit (e.g. after lowering it), waits for enough to age out', () => {
    // Limit 2 with 4 in the window: the count must fall to 1, so the three oldest must leave;
    // the third oldest (2 minutes ago) does so in 600 − 120 = 480 s.
    const times = [ago(540), ago(300), ago(120), ago(60)];
    expect(secondsUntilAllowed(times, 2, TEN_MINUTES, NOW)).toBe(480);
  });

  it('never answers less than one second while limited', () => {
    expect(secondsUntilAllowed([ago(599.9), ago(1), ago(1)], 3, TEN_MINUTES, NOW)).toBe(1);
  });
});
