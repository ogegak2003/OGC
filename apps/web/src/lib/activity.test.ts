import type { CallView } from '@ogc/types';
import { describe, expect, it } from 'vitest';
import { niceMax } from '../components/charts/scale';
import { callsByDay, missedSince, talkMinutes } from './activity';

const NOW = new Date(2026, 9, 16, 15, 0, 0);

function call(overrides: Partial<CallView>): CallView {
  return {
    id: crypto.randomUUID(),
    conversationId: 'c1',
    media: 'AUDIO',
    direction: 'INCOMING',
    peer: { ogcId: 'OGC306841127', displayName: 'Grace', avatarUrl: null },
    status: 'ENDED',
    outcome: 'COMPLETED',
    createdAt: NOW.toISOString(),
    answeredAt: null,
    connectedAt: null,
    endedAt: null,
    durationSeconds: null,
    ...overrides,
  } as CallView;
}

describe('call activity', () => {
  it('counts answered, missed and other calls per local day, oldest first', () => {
    const today = NOW.toISOString();
    const yesterday = new Date(2026, 9, 15, 9, 0).toISOString();
    const points = callsByDay(
      [
        call({ createdAt: today, connectedAt: today, durationSeconds: 125 }),
        call({ createdAt: today, outcome: 'MISSED' }),
        call({ createdAt: yesterday, direction: 'OUTGOING', outcome: 'MISSED' }),
        // Outside the window: ignored, not clamped onto the first day.
        call({ createdAt: new Date(2026, 8, 1).toISOString(), outcome: 'MISSED' }),
      ],
      7,
      NOW,
    );
    expect(points).toHaveLength(7);
    expect(points[6]?.values).toEqual({ answered: 1, missed: 1, other: 0 });
    expect(points[5]?.values).toEqual({ answered: 0, missed: 0, other: 1 });
    expect(points.slice(0, 5).every((p) => Object.values(p.values).every((v) => v === 0))).toBe(
      true,
    );
  });

  it('reports missed calls since a date and whole minutes talked', () => {
    const calls = [
      call({ outcome: 'MISSED' }),
      call({ outcome: 'MISSED', createdAt: new Date(2026, 9, 1).toISOString() }),
      call({ connectedAt: NOW.toISOString(), durationSeconds: 90 }),
      call({ connectedAt: NOW.toISOString(), durationSeconds: 45 }),
    ];
    expect(missedSince(calls, new Date(2026, 9, 9))).toBe(1);
    expect(talkMinutes(calls)).toBe(2);
  });

  it('scales the y axis to readable round numbers, never below one', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(48)).toBe(50);
  });
});
