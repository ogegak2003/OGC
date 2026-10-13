const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/** Short timestamp for lists: time today, weekday this week, otherwise the date. */
export function listTime(iso: string, now = new Date()): string {
  const value = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(value)) / 86_400_000);
  if (days <= 0) return time.format(value);
  if (days < 7) return weekday.format(value);
  return date.format(value);
}

export function messageTime(iso: string): string {
  return time.format(new Date(iso));
}

export function dayLabel(iso: string, now = new Date()): string {
  const value = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(value)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return fullDate.format(value);
}

export function sameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

export {
  attachmentKind,
  duration,
  fileSize,
  playableAudio,
  safeFileName,
  safeMime,
} from '@ogc/messaging';
