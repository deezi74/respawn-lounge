import type { Audience } from "./app-types";

export const POST_LIMITS = {
  text: 5000,
  photos: 4,
  photoBytes: 8 * 1024 * 1024,
} as const;
export type PostPhoto = {
  id: string;
  url: string;
  width: number;
  height: number;
};
export type RegularPost = {
  id: string;
  ownerId: number;
  ownerName: string;
  text: string;
  photos: PostPhoto[];
  destination: "profile" | "lounge";
  audience: Audience;
  loungeId?: string;
  loungeName?: string;
  createdAt: string;
  updatedAt?: string;
};
