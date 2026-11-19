export function insertEmoji(
  text: string,
  emoji: string,
  start = text.length,
  end = start,
  limit = 5000
): { value: string; caret: number } {
  const left = Math.max(0, Math.min(text.length, start)),
    right = Math.max(left, Math.min(text.length, end));
  const next = text.slice(0, left) + emoji + text.slice(right);
  return next.length <= limit
    ? { value: next, caret: left + emoji.length }
    : { value: text, caret: left };
}
