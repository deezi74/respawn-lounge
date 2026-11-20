export const WORLD_MODULES = [
  "quote",
  "music",
  "art",
  "people",
  "panels",
] as const;
export type WorldModule = (typeof WORLD_MODULES)[number];
export const WORLD_LIMITS = {
  audioBytes: 15 * 1024 * 1024,
  audioSeconds: 600,
  tracks: 3,
  art: 12,
  panels: 6,
  people: 8,
  imageBytes: 8 * 1024 * 1024,
} as const;
export type WorldAsset = {
  id: string;
  kind: "image" | "audio";
  url: string;
  width?: number;
  height?: number;
  duration?: number;
};
export type ProfileWorld = {
  quote: string;
  quoteAuthor: string;
  favoriteMusic: string[];
  music: { title: string; artist: string; mediaId: string }[];
  art: { title: string; caption: string; mediaId: string }[];
  panels: { id: string; title: string; text: string; accentColor: string }[];
  topPeople: number[];
  modules: Record<WorldModule, boolean>;
  moduleOrder: WorldModule[];
  chrome: "glass" | "chrome" | "minimal";
  portrait: "round" | "square";
  pageWidth: "wide" | "cozy";
};
export type WorldMedia = Record<string, WorldAsset>;
export function defaultProfileWorld(): ProfileWorld {
  return {
    quote: "",
    quoteAuthor: "",
    favoriteMusic: [],
    music: [],
    art: [],
    panels: [],
    topPeople: [],
    modules: {
      quote: true,
      music: true,
      art: true,
      people: true,
      panels: true,
    },
    moduleOrder: [...WORLD_MODULES],
    chrome: "glass",
    portrait: "round",
    pageWidth: "wide",
  };
}
