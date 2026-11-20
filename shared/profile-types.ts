import {
  defaultProfileWorld,
  type ProfileWorld,
  type WorldMedia,
} from "./profile-world-types";
export const PROFILE_ROLES = ["gamer", "creator", "streamer"] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];
export const PROFILE_MODULES = [
  "about",
  "links",
  "games",
  "posts",
  "clips",
] as const;
export type ProfileModule = (typeof PROFILE_MODULES)[number];
export const AVATAR_EMOJIS = [
  "🎮",
  "👾",
  "👻",
  "🤖",
  "🐉",
  "🦊",
  "🐱",
  "🐼",
  "🦁",
  "🐺",
  "🦄",
  "🐙",
  "🦈",
  "🦇",
  "🦉",
  "🐸",
  "🔥",
  "⚡",
  "🌙",
  "⭐",
  "💎",
  "🚀",
  "🛸",
  "🎧",
  "🕹️",
  "🎯",
  "👑",
  "🍄",
  "💀",
  "🌈",
] as const;
export const PROFILE_LIMITS = {
  imageBytes: 8 * 1024 * 1024,
  videoBytes: 20 * 1024 * 1024,
  videoSeconds: 30,
  links: 8,
} as const;
export type ProfileTheme = {
  backgroundMode: "solid" | "gradient" | "image" | "video";
  backgroundColor: string;
  backgroundColor2: string;
  accentColor: string;
  secondaryColor: string;
  textColor: string;
  cardColor: string;
  cardOpacity: number;
  backgroundOpacity: number;
  overlayOpacity: number;
  backgroundBlur: number;
  backgroundSize: "cover" | "contain" | "tile";
  backgroundPosition: "center" | "top" | "bottom";
  ghostOpacity: number;
  ghostPosition:
    | "center"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right";
  ghostSize: "small" | "medium" | "large";
  font: "inter" | "space" | "mono";
  layout: "classic" | "spotlight" | "compact";
  corners: "square" | "rounded" | "soft";
  glow: "none" | "subtle" | "strong";
  modules: Record<ProfileModule, boolean>;
  moduleOrder: ProfileModule[];
};
export type ProfileSettings = {
  visibility: "public" | "members" | "private";
  discoverable: boolean;
  allowFollow: boolean;
  allowComments: boolean;
  allowReactions: boolean;
  showFollowerCount: boolean;
  reducedMotion: boolean;
  autoplayBackground: boolean;
};
export type ProfileAsset = {
  id: string;
  kind: "image" | "video";
  url: string;
  posterUrl?: string;
  width: number;
  height: number;
  duration?: number;
};
export type Profile = {
  ownerId: number;
  displayName: string;
  headline: string;
  bio: string;
  pronouns: string;
  roles: ProfileRole[];
  status: string;
  statusEmoji: string;
  avatarEmoji: string;
  games: string[];
  platforms: string[];
  links: { label: string; url: string }[];
  avatarMediaId: string | null;
  bannerMediaId: string | null;
  backgroundMediaId: string | null;
  ghostMediaId: string | null;
  world: ProfileWorld;
  worldMedia: WorldMedia;
  theme: ProfileTheme;
  settings: ProfileSettings;
  media: {
    avatar?: ProfileAsset;
    banner?: ProfileAsset;
    background?: ProfileAsset;
    ghost?: ProfileAsset;
  };
  createdAt?: string;
  updatedAt?: string;
  saved: boolean;
};
export type ProfileInput = Omit<
  Profile,
  "ownerId" | "media" | "worldMedia" | "createdAt" | "updatedAt" | "saved"
>;
export function defaultProfile(
  ownerId: number,
  displayName = "Gamer"
): Profile {
  return {
    ownerId,
    displayName,
    headline: "",
    bio: "",
    pronouns: "",
    roles: ["gamer"],
    status: "",
    statusEmoji: "🎮",
    avatarEmoji: "🎮",
    games: [],
    platforms: [],
    links: [],
    avatarMediaId: null,
    bannerMediaId: null,
    backgroundMediaId: null,
    ghostMediaId: null,
    world: defaultProfileWorld(),
    worldMedia: {},
    theme: {
      backgroundMode: "gradient",
      backgroundColor: "#090b14",
      backgroundColor2: "#211038",
      accentColor: "#00e5ff",
      secondaryColor: "#ff3da6",
      textColor: "#f2f5ff",
      cardColor: "#121625",
      cardOpacity: 0.94,
      backgroundOpacity: 1,
      overlayOpacity: 0.45,
      backgroundBlur: 0,
      backgroundSize: "cover",
      backgroundPosition: "center",
      ghostOpacity: 0.12,
      ghostPosition: "bottom-right",
      ghostSize: "medium",
      font: "space",
      layout: "classic",
      corners: "rounded",
      glow: "subtle",
      modules: {
        about: true,
        links: true,
        games: true,
        posts: true,
        clips: true,
      },
      moduleOrder: [...PROFILE_MODULES],
    },
    settings: {
      visibility: "public",
      discoverable: true,
      allowFollow: true,
      allowComments: true,
      allowReactions: true,
      showFollowerCount: true,
      reducedMotion: false,
      autoplayBackground: false,
    },
    media: {},
    saved: false,
  };
}
export function canViewProfile(
  profile: Pick<Profile, "ownerId" | "settings">,
  viewerId?: number
): boolean {
  return (
    profile.ownerId === viewerId ||
    profile.settings.visibility === "public" ||
    (profile.settings.visibility === "members" && !!viewerId)
  );
}
