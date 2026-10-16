import { isMissedCall } from '@ogc/messaging';
import type { CallView } from '@ogc/types';
import type { ChartPoint } from '../components/charts/BarChart';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Calls per local day for the last `days` days (today included), split into answered (media
 * connected), missed (incoming, never answered) and other (declined, unanswered outgoing,
 * failed). Built only from the call history the server returned — nothing is estimated.
 */
export function callsByDay(
  calls: readonly CallView[],
  days: number,
  now = new Date(),
): ChartPoint[] {
  const today = startOfDay(now);
  const first = new Date(today.getTime() - (days - 1) * DAY_MS);
  const points: ChartPoint[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    points.push({
      label: day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }),
      longLabel: day.toLocaleDateString(undefined, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }),
      values: { answered: 0, missed: 0, other: 0 },
    });
  }
  for (const call of calls) {
    const created = new Date(call.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    const index = Math.round((startOfDay(created).getTime() - first.getTime()) / DAY_MS);
    const point = points[index];
    if (!point) continue;
    const key = call.connectedAt ? 'answered' : isMissedCall(call) ? 'missed' : 'other';
    point.values[key] = (point.values[key] ?? 0) + 1;
  }
  return points;
}

/** Missed incoming calls since `since`. */
export function missedSince(calls: readonly CallView[], since: Date): number {
  return calls.filter(
    (call) => isMissedCall(call) && new Date(call.createdAt).getTime() >= since.getTime(),
  ).length;
}

/** Minutes of connected calls (whole minutes, rounded down) in the given list. */
export function talkMinutes(calls: readonly CallView[]): number {
  return Math.floor(calls.reduce((sum, call) => sum + (call.durationSeconds ?? 0), 0) / 60);
}
