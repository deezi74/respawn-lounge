import type { WorldAsset } from "@shared/profile-world-types";
export function worldMediaUrl(
  assetId: string,
  value: string | undefined,
  origin: string
): string | null {
  try {
    if (!value || !assetId || !/^[a-zA-Z0-9_-]+$/.test(assetId)) return null;
    const url = new URL(value, origin);
    if (
      url.origin !== new URL(origin).origin ||
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== `/api/media/profile-world/${encodeURIComponent(assetId)}`
    )
      return null;
    if (
      [...url.searchParams.keys()].some(key => key !== "ticket") ||
      url.searchParams.getAll("ticket").length > 1
    )
      return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
export function playableWorldAudio(
  asset: WorldAsset | undefined,
  id: string,
  origin: string
): string | null {
  return asset?.id === id &&
    asset.kind === "audio" &&
    Number.isFinite(asset.duration) &&
    asset.duration! > 0 &&
    asset.duration! <= 600
    ? worldMediaUrl(id, asset.url, origin)
    : null;
}
export function playlistIndex(
  index: number,
  delta: number,
  length: number
): number {
  return length > 0 ? (((index + delta) % length) + length) % length : 0;
}
export function musicTime(value: number): string {
  const n = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

/** An empty playlist has no audio node; mounting its first track needs a fresh cleanup scope. */
export function musicSessionKey(ownerId: number, trackCount: number): string {
  return `${ownerId}:${trackCount > 0 ? "audio" : "empty"}`;
}
