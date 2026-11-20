import type { Profile } from "@shared/profile-types";
import { worldMediaUrl } from "./profile-music-utils";
export { worldMediaUrl } from "./profile-music-utils";
import {
  defaultProfileWorld,
  WORLD_LIMITS,
  WORLD_MODULES,
  type ProfileWorld,
  type WorldAsset,
  type WorldMedia,
} from "@shared/profile-world-types";

export const WORLD_TEXT_LIMITS = {
  quote: 500,
  quoteAuthor: 80,
  musicTag: 80,
  favoriteMusic: 20,
  title: 100,
  artist: 100,
  caption: 500,
  panelTitle: 80,
  panelText: 5000,
} as const;
export const WORLD_SECTION_LABELS = {
  quote: "Favorite quote",
  music: "My soundtrack",
  art: "Art & gallery",
  people: "Top people",
  panels: "More of my world",
} as const;
export type WorldSlot = "music" | "art";
const plain = (value: unknown, max: number, required = false) =>
  typeof value === "string" &&
  value.length <= max &&
  (!required || Boolean(value.trim())) &&
  !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const assetId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
const unique = (values: unknown[]) => new Set(values).size === values.length;
const onlyKeys = (value: object, keys: string[]) =>
  Object.keys(value).every(key => keys.includes(key));

/** Missing legacy fields get defaults; supplied values remain intact for strict validation. */
export function profileWorld(
  value?: Partial<ProfileWorld> | null
): ProfileWorld {
  const defaults = defaultProfileWorld();
  return {
    ...defaults,
    ...value,
    modules: { ...defaults.modules, ...value?.modules },
  };
}
export function withProfileWorld(profile: Profile): Profile {
  return {
    ...profile,
    world: profileWorld(profile.world),
    worldMedia: profile.worldMedia || {},
  };
}
export function selectedWorldMedia(
  world: ProfileWorld,
  media: WorldMedia
): WorldMedia {
  const ids = new Set([...world.music, ...world.art].map(item => item.mediaId));
  return Object.fromEntries(
    Object.entries(media).filter(([id]) => ids.has(id))
  );
}
export function moveWorldItem<T>(
  items: T[],
  index: number,
  direction: -1 | 1
): T[] {
  const next = index + direction;
  const result = [...items];
  if (index >= 0 && next >= 0 && next < result.length)
    [result[index], result[next]] = [result[next], result[index]];
  return result;
}

export function validWorldAsset(
  asset: WorldAsset,
  slot: WorldSlot,
  origin: string
): boolean {
  if (!asset || !worldMediaUrl(asset.id, asset.url, origin)) return false;
  return slot === "music"
    ? asset.kind === "audio" &&
        typeof asset.duration === "number" &&
        Number.isFinite(asset.duration) &&
        asset.duration > 0 &&
        asset.duration <= WORLD_LIMITS.audioSeconds
    : asset.kind === "image" &&
        Number.isInteger(asset.width) &&
        Number.isInteger(asset.height) &&
        (asset.width || 0) > 0 &&
        (asset.height || 0) > 0;
}
export function worldUploadError(
  file: Pick<File, "size" | "type" | "name">,
  slot: WorldSlot,
  rightsConfirmed = false
): string | null {
  if (slot === "music" && !rightsConfirmed)
    return "Acknowledge that you own or have permission to upload this music first.";
  if (!file.size) return "This file is empty. Choose another file.";
  if (slot === "art") {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
      return "Choose JPEG, PNG or WebP artwork.";
    return file.size > WORLD_LIMITS.imageBytes
      ? "Artwork must be 8 MiB or smaller."
      : null;
  }
  const formats = [
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/wave",
    "audio/x-wav",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/ogg",
    "application/ogg",
  ];
  if (
    !/\.(mp3|wav|m4a|ogg)$/i.test(file.name) ||
    (file.type && !formats.includes(file.type))
  )
    return "Choose an audio-only MP3, WAV, M4A or OGG file. No external music URLs.";
  return file.size > WORLD_LIMITS.audioBytes
    ? "Music must be 15 MiB or smaller and at most 10 minutes."
    : null;
}
export function worldMediaForm(
  file: File,
  slot: WorldSlot,
  rightsConfirmed = false
): FormData {
  const form = new FormData();
  // Multipart authorization metadata must precede file bytes.
  form.append("slot", slot);
  form.append("confirmed", "true");
  if (slot === "music") form.append("rightsConfirmed", String(rightsConfirmed));
  const types: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
  };
  const type = types[file.name.split(".").pop()?.toLowerCase() || ""];
  // Some browsers report an empty/alias MIME; native server checks still verify the actual bytes.
  const normalized =
    slot === "music" &&
    type &&
    ![
      "audio/mpeg",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/x-m4a",
      "audio/ogg",
    ].includes(file.type)
      ? new File([file], file.name, { type, lastModified: file.lastModified })
      : file;
  form.append("file", normalized);
  return form;
}
export function worldFileTitle(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, "")
      .replace(/[<>\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, WORLD_TEXT_LIMITS.title) || "Untitled upload"
  );
}
export function chromeProfilePreset(profile: Profile): Profile {
  return {
    ...withProfileWorld(profile),
    world: {
      ...profileWorld(profile.world),
      chrome: "chrome",
      portrait: "square",
      pageWidth: "cozy",
    },
    theme: {
      ...profile.theme,
      layout: "classic",
      backgroundColor: "#071426",
      backgroundColor2: "#123767",
      accentColor: "#70baff",
      secondaryColor: "#c5dafa",
      textColor: "#f2f6ff",
      cardColor: "#122946",
    },
  };
}

export function validateWorldDraft(value?: ProfileWorld): string | null {
  const world = value === undefined ? defaultProfileWorld() : value;
  if (
    !world ||
    typeof world !== "object" ||
    !onlyKeys(world, Object.keys(defaultProfileWorld()))
  )
    return "Use only the supported structured personal-page fields.";
  const L = WORLD_TEXT_LIMITS;
  if (!plain(world.quote, L.quote) || !plain(world.quoteAuthor, L.quoteAuthor))
    return "Use a plain-text quote of up to 500 characters and author of up to 80 characters.";
  if (
    !Array.isArray(world.favoriteMusic) ||
    world.favoriteMusic.length > L.favoriteMusic ||
    !unique(
      world.favoriteMusic.map(tag =>
        typeof tag === "string" ? tag.trim().toLocaleLowerCase() : tag
      )
    ) ||
    world.favoriteMusic.some(tag => !plain(tag, L.musicTag, true))
  )
    return "Add up to 20 unique favorite-music tags, at most 80 characters each.";
  if (
    !Array.isArray(world.music) ||
    world.music.length > WORLD_LIMITS.tracks ||
    world.music.some(
      track =>
        !track ||
        !onlyKeys(track, ["title", "artist", "mediaId"]) ||
        !plain(track.title, L.title) ||
        !plain(track.artist, L.artist) ||
        !assetId(track.mediaId)
    )
  )
    return "Add up to three uploaded tracks, with titles and artist credits of at most 100 characters.";
  if (
    !Array.isArray(world.art) ||
    world.art.length > WORLD_LIMITS.art ||
    world.art.some(
      art =>
        !art ||
        !onlyKeys(art, ["title", "caption", "mediaId"]) ||
        !plain(art.title, L.title) ||
        !plain(art.caption, L.caption) ||
        !assetId(art.mediaId)
    )
  )
    return "Add up to 12 uploaded artworks, with titles of at most 100 characters and captions of at most 500.";
  if (
    !Array.isArray(world.panels) ||
    world.panels.length > WORLD_LIMITS.panels ||
    world.panels.some(
      panel =>
        !panel ||
        !onlyKeys(panel, ["id", "title", "text", "accentColor"]) ||
        !plain(panel.id, 40, true) ||
        !plain(panel.title, L.panelTitle) ||
        !plain(panel.text, L.panelText) ||
        !/^#[0-9a-fA-F]{6}$/.test(panel.accentColor)
    ) ||
    !unique(world.panels.map(panel => panel.id.trim()))
  )
    return "Add up to six plain-text panels with unique IDs (40 characters), titles (80), text (5,000), and six-digit accent colors.";
  if (
    !Array.isArray(world.topPeople) ||
    world.topPeople.length > WORLD_LIMITS.people ||
    !unique(world.topPeople) ||
    world.topPeople.some(id => !Number.isSafeInteger(id) || id <= 0)
  )
    return "Choose up to eight different real, visible member profiles.";
  if (
    !world.modules ||
    WORLD_MODULES.some(key => typeof world.modules[key] !== "boolean") ||
    Object.keys(world.modules).some(
      key => !WORLD_MODULES.includes(key as (typeof WORLD_MODULES)[number])
    ) ||
    !Array.isArray(world.moduleOrder) ||
    world.moduleOrder.length !== WORLD_MODULES.length ||
    !unique(world.moduleOrder) ||
    world.moduleOrder.some(key => !WORLD_MODULES.includes(key))
  )
    return "Personal-page sections must contain all five sections exactly once, with valid visibility settings.";
  if (
    !["glass", "chrome", "minimal"].includes(world.chrome) ||
    !["round", "square"].includes(world.portrait) ||
    !["wide", "cozy"].includes(world.pageWidth)
  )
    return "Choose a supported panel style, portrait shape and page width.";
  return null;
}
