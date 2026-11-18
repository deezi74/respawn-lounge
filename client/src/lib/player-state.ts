import type { Caption } from "@shared/app-types";

export function localDateTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
export function sourceTime(currentTime: number, clipStart = 0): number {
  return Math.max(0, currentTime + clipStart);
}
export function trimmedCaptions(
  captions: Caption[],
  originalStart: number,
  nextStart: number,
  nextEnd: number
): Caption[] {
  const shift = originalStart - nextStart;
  const duration = nextEnd - nextStart;
  return captions
    .map(c => ({
      ...c,
      start: Math.max(0, c.start + shift),
      end: Math.min(duration, c.end + shift),
    }))
    .filter(
      c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start
    );
}
