export type Audience = "public" | "lounge";
export type Caption = { start: number; end: number; text: string };
export type Crop = "original" | "vertical" | "square";
export type Source = {
  id: string;
  creatorId: number;
  creatorName: string;
  title: string;
  game: string;
  kind: "upload" | "live" | "replay";
  audience: Audience;
  loungeId?: string;
  allowClip: "everyone" | "members" | "creator";
  allowPublish: boolean;
  allowDownload: boolean;
  duration: number;
  status: "uploading" | "processing" | "ready" | "live" | "offline" | "error";
  createdAt: string;
  error?: string;
  transcript: Caption[];
  transcriptionStatus?: string;
  posterUrl?: string;
  playbackUrl?: string;
  liveInputId?: string;
  recordingId?: string;
};
export type Clip = {
  id: string;
  ownerId: number;
  ownerName: string;
  sourceId: string;
  creatorId: number;
  creatorName: string;
  title: string;
  game: string;
  start: number;
  end: number;
  crop: Crop;
  cropX: number;
  cropY: number;
  captions: Caption[];
  overlay: string;
  audience: Audience;
  loungeId?: string;
  status: "queued" | "processing" | "ready" | "bookmarked" | "error";
  error?: string;
  published: boolean;
  destination?: "profile" | "lounge";
  createdAt: string;
  playbackUrl?: string;
  posterUrl?: string;
  footageNote?: string;
  transcriptionStatus?: "queued" | "processing" | "ready" | "error";
  transcriptionError?: string;
};
export type Lounge = {
  id: string;
  ownerId: number;
  name: string;
  description: string;
  game: string;
  privacy: "public" | "private";
  members: number[];
  requests: { userId: number; name: string; createdAt: string }[];
  createdAt: string;
};
export type Squad = {
  id: string;
  ownerId: number;
  ownerName: string;
  title: string;
  game: string;
  platform: string;
  mic: "required" | "optional" | "no-mic";
  startsAt: string;
  expiresAt: string;
  capacity: number;
  members: number[];
  requests: { userId: number; name: string; createdAt: string }[];
  vibe: "Chill" | "Competitive" | "Learning";
  createdAt: string;
};
export type Preferences = {
  enabled: boolean;
  name: string;
  avatar: string;
  accent: string;
  tone: "Chill" | "Hype" | "Straight to the Point";
  personalization: boolean;
  clipDuration: 15 | 30 | 60;
  games: string[];
  platform: string;
  mic: string;
  availability: string;
};
export const defaultPreferences: Preferences = {
  enabled: true,
  name: "Nova",
  avatar: "orbit",
  accent: "#00E5FF",
  tone: "Chill",
  personalization: false,
  clipDuration: 30,
  games: [],
  platform: "PC",
  mic: "optional",
  availability: "Tonight",
};
export type StudioSettings = {
  title: string;
  game: string;
  scheduledAt?: string;
  sourceId?: string;
  liveInputId?: string;
  connected: boolean;
  provider: "Cloudflare Stream";
  rtmpsUrl?: string;
  streamKey?: string;
  status?: string;
};
export type ChatMessage = {
  id: string;
  ownerId: number;
  name: string;
  sourceId: string;
  text: string;
  position: number;
  createdAt: string;
};
export type ServiceState = {
  ai: boolean;
  transcription: boolean;
  processing: boolean;
  live: boolean;
  liveReason?: string;
};
export type SidekickResult = {
  message: string;
  action?: "clip" | "edit" | "squads" | "studio" | "seek" | "confirm";
  clip?: Clip;
  moments?: { position: number; text: string }[];
  squads?: Squad[];
  requiresConfirmation?: boolean;
  basedOn?: string;
};
