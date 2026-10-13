const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function daysAgo(iso: string, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
}

export function listTime(iso: string, now = new Date()): string {
  const days = daysAgo(iso, now);
  if (days <= 0) return time.format(new Date(iso));
  if (days < 7) return weekday.format(new Date(iso));
  return date.format(new Date(iso));
}

export function messageTime(iso: string): string {
  return time.format(new Date(iso));
}

export function dayLabel(iso: string, now = new Date()): string {
  const days = daysAgo(iso, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return fullDate.format(new Date(iso));
}

export function sameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}
