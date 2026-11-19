import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import { canViewProfile, type Profile } from "../../shared/profile-types";
import {
  REACTION_EMOJIS,
  type FollowSummary,
  type PostComment,
  type PostSocial,
  type ReactionEmoji,
} from "../../shared/social-types";
import { fail, needUser, optionalUser, route } from "./access";
import { assertPostReadable } from "./posts";
import * as store from "./store";

type FollowRecord = {
  id: string;
  ownerId: number;
  targetId: number;
  following: boolean;
  updatedAt: string;
};
type ReactionRecord = {
  id: string;
  ownerId: number;
  postId: string;
  emoji: ReactionEmoji | null;
  updatedAt: string;
};
type CommentRecord = Omit<PostComment, "canDelete"> & { deletedAt?: string };
type StoredProfile = Profile & { deletedAt?: string };

const confirmation = z.object({ confirmed: z.literal(true) }).strict();
const followInput = confirmation.extend({ following: z.boolean() }).strict();
const reactionInput = confirmation
  .extend({ emoji: z.enum(REACTION_EMOJIS).nullable() })
  .strict();
const commentInput = confirmation
  .extend({
    text: z
      .string()
      .max(1000)
      .trim()
      .min(1)
      .refine(
        value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),
        {
          message: "Comment contains unsupported control characters",
        }
      ),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    fail(400, "Invalid social request; check its fields and confirmation");
  return result.data;
}
function profileId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail(400, "Invalid profile ID");
  return Number(value);
}
function resourceId(value: string): string {
  if (!value || value.length > 191 || /[\u0000-\u001f\u007f]/.test(value))
    fail(400, "Invalid resource ID");
  return value;
}
const followId = (actorId: number, targetId: number) =>
  `follow:${actorId}:${targetId}`;
// Hash the opaque post ID so every valid appRecords ID fits the primary key limit.
const reactionId = (actorId: number, postId: string) =>
  `reaction:${actorId}:${createHash("sha256").update(postId).digest("hex")}`;

function databaseCode(error: unknown): string | undefined {
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === "object";
    depth++
  ) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string") return value.code;
    current = value.cause;
  }
}
/** Retry only MySQL failures whose transaction has rolled back, never ambiguous writes. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (
        attempt >= 2 ||
        !["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(
          databaseCode(error) ?? ""
        )
      )
        throw error;
      await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
}
/** Inert first creation plus row-locked assignment is duplicate-safe across server processes. */
async function assignUnique<T extends { id: string }>(
  kind: string,
  ownerId: number,
  initial: T,
  beforeWrite: () => Promise<unknown>,
  update: (value: T) => T
): Promise<T> {
  return retry(async () => {
    if (!(await store.get<T>(kind, initial.id))) {
      try {
        await store.create(kind, ownerId, initial);
      } catch (error) {
        if (databaseCode(error) !== "ER_DUP_ENTRY") throw error;
      }
    }
    await beforeWrite();
    return store.mutate<T>(kind, initial.id, update);
  });
}

// Process-local overload protection only; durable correctness comes from unique IDs and DB locks.
const activeUsers = new Map<number, number>();
let activeWrites = 0;
async function boundedWrite<T>(
  userId: number,
  fn: () => Promise<T>
): Promise<T> {
  const count = activeUsers.get(userId) ?? 0;
  if (activeWrites >= 128 || count >= 32)
    fail(429, "Too many social changes in progress; please retry shortly");
  activeWrites++;
  activeUsers.set(userId, count + 1);
  try {
    return await fn();
  } finally {
    activeWrites--;
    const remaining = (activeUsers.get(userId) ?? 1) - 1;
    if (remaining) activeUsers.set(userId, remaining);
    else activeUsers.delete(userId);
  }
}
const commentWindows = new Map<number, { expiresAt: number; used: number }>();
function reserveComment(userId: number): () => void {
  const now = Date.now();
  for (const [id, window] of commentWindows)
    if (window.expiresAt <= now) commentWindows.delete(id);
  let window = commentWindows.get(userId);
  if (!window) {
    if (commentWindows.size >= 5000)
      fail(429, "Comments are busy; please retry in a minute");
    window = { expiresAt: now + 60_000, used: 0 };
    commentWindows.set(userId, window);
  }
  if (window.used >= 8)
    fail(429, "Please wait a minute before adding more comments");
  window.used++;
  return () => {
    window.used = Math.max(0, window.used - 1);
  };
}

async function profile(ownerId: number): Promise<StoredProfile | undefined> {
  const value = await store.get<StoredProfile>("profile", `profile:${ownerId}`);
  return value?.ownerId === ownerId && !value.deletedAt ? value : undefined;
}
async function visibleProfile(
  ownerId: number,
  viewerId?: number
): Promise<Profile> {
  const value = await profile(ownerId);
  if (!value || !canViewProfile(value, viewerId))
    fail(404, "Profile not found");
  return value;
}
async function followSummary(
  value: Profile,
  viewerId?: number
): Promise<FollowSummary> {
  const own = viewerId === value.ownerId;
  const showCounts = own || value.settings.showFollowerCount;
  const mine = viewerId
    ? await store.get<FollowRecord>("follow", followId(viewerId, value.ownerId))
    : undefined;
  const result: FollowSummary = {
    following: !!mine?.following,
    canFollow: !!viewerId && !own && value.settings.allowFollow,
  };
  if (showCounts) {
    const rows = await store.list<FollowRecord>("follow");
    result.followers = rows.filter(
      row => row.targetId === value.ownerId && row.following
    ).length;
    result.followingCount = rows.filter(
      row => row.ownerId === value.ownerId && row.following
    ).length;
  }
  return result;
}
async function currentFollowSummary(
  ownerId: number,
  viewerId?: number
): Promise<FollowSummary> {
  const value = await visibleProfile(ownerId, viewerId);
  const result = await followSummary(value, viewerId);
  // A privacy/count-setting change during the reads must not leak the previous view.
  const current = await visibleProfile(ownerId, viewerId);
  if (current.ownerId !== viewerId && !current.settings.showFollowerCount) {
    delete result.followers;
    delete result.followingCount;
  }
  result.canFollow =
    !!viewerId && viewerId !== ownerId && current.settings.allowFollow;
  return result;
}
async function postPermissions(postId: string, viewerId?: number) {
  const post = await assertPostReadable(postId, viewerId);
  const ownerProfile = await profile(post.ownerId);
  await assertPostReadable(postId, viewerId);
  return {
    ownerId: post.ownerId,
    canComment: !!viewerId && (ownerProfile?.settings.allowComments ?? true),
    canReact: !!viewerId && (ownerProfile?.settings.allowReactions ?? true),
  };
}
async function postSummary(
  postId: string,
  viewerId?: number
): Promise<PostSocial> {
  await assertPostReadable(postId, viewerId);
  const [reactions, comments] = await Promise.all([
    store.list<ReactionRecord>("post-reaction"),
    store.list<CommentRecord>("post-comment"),
  ]);
  const active = reactions.filter(
    row => row.postId === postId && row.emoji !== null
  );
  const permissions = await postPermissions(postId, viewerId);
  return {
    reactions: REACTION_EMOJIS.map(emoji => ({
      emoji,
      count: active.filter(row => row.emoji === emoji).length,
    })).filter(row => row.count > 0),
    myReaction: active.find(row => row.ownerId === viewerId)?.emoji ?? null,
    commentsCount: comments.filter(
      row => row.postId === postId && !row.deletedAt
    ).length,
    canComment: permissions.canComment,
    canReact: permissions.canReact,
  };
}
function publicComment(
  comment: CommentRecord,
  viewerId?: number,
  postOwnerId?: number
): PostComment {
  return {
    id: comment.id,
    postId: comment.postId,
    ownerId: comment.ownerId,
    ownerName: comment.ownerName,
    text: comment.text,
    createdAt: comment.createdAt,
    canDelete:
      !!viewerId && (comment.ownerId === viewerId || postOwnerId === viewerId),
  };
}

export function registerSocialRoutes(app: Express) {
  app.get(
    "/api/app/profiles/:id/social",
    route(async (req, res) => {
      const user = await optionalUser(req);
      res.json(await currentFollowSummary(profileId(req.params.id), user?.id));
    })
  );
  app.post(
    "/api/app/profiles/:id/follow",
    route(async (req, res) => {
      const user = await needUser(req);
      const input = parse(followInput, req.body);
      const targetId = profileId(req.params.id);
      await boundedWrite(user.id, async () => {
        const id = followId(user.id, targetId);
        if (input.following) {
          if (user.id === targetId) fail(400, "You cannot follow yourself");
          const approve = async () => {
            const value = await visibleProfile(targetId, user.id);
            if (!value.settings.allowFollow)
              fail(403, "This member is not accepting followers");
          };
          await approve();
          await assignUnique<FollowRecord>(
            "follow",
            user.id,
            {
              id,
              ownerId: user.id,
              targetId,
              following: false,
              updatedAt: new Date().toISOString(),
            },
            approve,
            current => ({
              ...current,
              following: true,
              updatedAt: new Date().toISOString(),
            })
          );
        } else {
          // Revocation never requires reading a target's now-private/deleted profile.
          if (await store.get<FollowRecord>("follow", id))
            await retry(() =>
              store.mutate<FollowRecord>("follow", id, current => ({
                ...current,
                following: false,
                updatedAt: new Date().toISOString(),
              }))
            );
        }
        if (!input.following) {
          const value = await profile(targetId);
          if (!value || !canViewProfile(value, user.id)) {
            res.json({
              following: false,
              canFollow: false,
            } satisfies FollowSummary);
            return;
          }
        }
        res.json(await currentFollowSummary(targetId, user.id));
      });
    })
  );
  app.get(
    "/api/app/posts/:id/social",
    route(async (req, res) => {
      const user = await optionalUser(req);
      res.json(await postSummary(resourceId(req.params.id), user?.id));
    })
  );
  app.post(
    "/api/app/posts/:id/reaction",
    route(async (req, res) => {
      const user = await needUser(req);
      const input = parse(reactionInput, req.body);
      const postId = resourceId(req.params.id);
      await boundedWrite(user.id, async () => {
        const approve = async () => {
          const permission = await postPermissions(postId, user.id);
          if (input.emoji !== null && !permission.canReact)
            fail(403, "Reactions are disabled for this member's posts");
        };
        await approve();
        const id = reactionId(user.id, postId);
        if (input.emoji === null) {
          if (await store.get<ReactionRecord>("post-reaction", id)) {
            await retry(async () => {
              await approve();
              return store.mutate<ReactionRecord>(
                "post-reaction",
                id,
                current => ({
                  ...current,
                  emoji: null,
                  updatedAt: new Date().toISOString(),
                })
              );
            });
          }
        } else {
          await assignUnique<ReactionRecord>(
            "post-reaction",
            user.id,
            {
              id,
              ownerId: user.id,
              postId,
              emoji: null,
              updatedAt: new Date().toISOString(),
            },
            approve,
            current => ({
              ...current,
              emoji: input.emoji,
              updatedAt: new Date().toISOString(),
            })
          );
        }
        res.json(await postSummary(postId, user.id));
      });
    })
  );
  app.get(
    "/api/app/posts/:id/comments",
    route(async (req, res) => {
      const user = await optionalUser(req);
      const postId = resourceId(req.params.id);
      await assertPostReadable(postId, user?.id);
      const comments = (await store.list<CommentRecord>("post-comment"))
        .filter(row => row.postId === postId && !row.deletedAt)
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
        )
        .slice(0, 50)
        .reverse();
      const post = await assertPostReadable(postId, user?.id);
      res.json(
        comments.map(comment => publicComment(comment, user?.id, post.ownerId))
      );
    })
  );
  app.post(
    "/api/app/posts/:id/comments",
    route(async (req, res) => {
      const user = await needUser(req);
      const input = parse(commentInput, req.body);
      const postId = resourceId(req.params.id);
      await boundedWrite(user.id, async () => {
        const permission = await postPermissions(postId, user.id);
        if (!permission.canComment)
          fail(403, "Comments are disabled for this member's posts");
        const refund = reserveComment(user.id);
        let persisted = false;
        try {
          const current = await postPermissions(postId, user.id);
          if (!current.canComment)
            fail(403, "Comments are disabled for this member's posts");
          const comment: CommentRecord = {
            id: randomUUID(),
            postId,
            ownerId: user.id,
            // Use authenticated identity, not a submitted name or hidden profile fields.
            ownerName: user.name?.trim().slice(0, 100) || "Member",
            text: input.text,
            createdAt: new Date().toISOString(),
          };
          await retry(async () => {
            const latest = await postPermissions(postId, user.id);
            if (!latest.canComment)
              fail(403, "Comments are disabled for this member's posts");
            return store.create("post-comment", user.id, comment);
          });
          persisted = true;
          const post = await assertPostReadable(postId, user.id);
          res.status(201).json(publicComment(comment, user.id, post.ownerId));
        } finally {
          if (!persisted) refund();
        }
      });
    })
  );
  app.delete(
    "/api/app/posts/:id/comments/:commentId",
    route(async (req, res) => {
      const user = await needUser(req);
      parse(confirmation, req.body);
      const postId = resourceId(req.params.id);
      const commentId = resourceId(req.params.commentId);
      await boundedWrite(user.id, async () => {
        await retry(async () => {
          const post = await assertPostReadable(postId, user.id);
          return store.mutate<CommentRecord>(
            "post-comment",
            commentId,
            current => {
              if (current.postId !== postId) fail(404, "Comment not found");
              if (current.ownerId !== user.id && post.ownerId !== user.id)
                fail(
                  403,
                  "Only the comment author or post owner can delete it"
                );
              return {
                ...current,
                deletedAt: current.deletedAt ?? new Date().toISOString(),
              };
            }
          );
        });
        await assertPostReadable(postId, user.id);
        res.json({ deleted: true });
      });
    })
  );
}
