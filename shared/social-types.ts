export const REACTION_EMOJIS = [
  "🎮",
  "🔥",
  "❤️",
  "😂",
  "👏",
  "😮",
  "💯",
  "🚀",
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
export type PostSocial = {
  reactions: { emoji: ReactionEmoji; count: number }[];
  myReaction: ReactionEmoji | null;
  commentsCount: number;
  canComment: boolean;
  canReact: boolean;
};
export type PostComment = {
  id: string;
  postId: string;
  ownerId: number;
  ownerName: string;
  text: string;
  createdAt: string;
  canDelete: boolean;
};
export type FollowSummary = {
  following: boolean;
  followers?: number;
  followingCount?: number;
  canFollow: boolean;
};
