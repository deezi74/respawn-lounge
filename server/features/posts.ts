import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import type { User } from "../../drizzle/schema";
import type { Audience, Lounge } from "../../shared/app-types";
import { POST_LIMITS, type RegularPost } from "../../shared/post-types";
import { storageGetSignedUrl, storagePut } from "../storage";
import {
  fail,
  HttpError,
  mediaTicket,
  needUser,
  optionalUser,
  route,
  ticketUser,
} from "./access";
import * as store from "./store";

// Only opaque keys and sanitized image properties are persisted. Storage URLs are discarded.
type PhotoRecord = {
  id: string;
  key: string;
  width: number;
  height: number;
  bytes: number;
};
type PostRecord = Omit<RegularPost, "photos"> & {
  photos: PhotoRecord[];
  deletedAt?: string;
};
type Fields = Pick<
  RegularPost,
  "text" | "destination" | "audience" | "loungeId" | "loungeName"
>;
const MAX_PIXELS = 24_000_000;
const MAX_DIMENSION = 16_384;
const OUTPUT_DIMENSION = 2048;
const PHOTO_TIMEOUT_MS = 10_000;
const uploadUsers = new WeakMap<Request, User>();
const approvedFields = new WeakMap<Request, string>();
const uploadOwners = new Set<number>();
let uploadsInFlight = 0;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "A request object is required");
  return value as Record<string, unknown>;
}
function known(body: Record<string, unknown>, fields: string[]) {
  if (Object.keys(body).some(key => !fields.includes(key)))
    fail(400, "Unsupported field in request");
}
function postText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > POST_LIMITS.text ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    fail(400, `Post text must be at most ${POST_LIMITS.text} characters`);
  return value.trim();
}
function member(lounge: Lounge, userId?: number): boolean {
  return (
    !!userId && (lounge.ownerId === userId || lounge.members.includes(userId))
  );
}
function effectiveAudience(post: PostRecord, lounge?: Lounge): Audience {
  return post.destination === "profile"
    ? "public"
    : post.audience === "public" && lounge?.privacy === "public"
      ? "public"
      : "lounge";
}
/** Missing Lounges fail closed, including for the author. Private creation never broadens. */
async function access(
  post: PostRecord,
  userId?: number
): Promise<{ audience: Audience; lounge?: Lounge } | null> {
  if (post.deletedAt) return null;
  if (post.destination === "profile")
    return post.audience === "public" ? { audience: "public" } : null;
  if (post.destination !== "lounge" || !post.loungeId) return null;
  const lounge = await store.get<Lounge>("lounge", post.loungeId);
  if (!lounge || !["public", "private"].includes(lounge.privacy)) return null;
  const audience = effectiveAudience(post, lounge);
  return audience === "public" ||
    post.ownerId === userId ||
    member(lounge, userId)
    ? { audience, lounge }
    : null;
}
function serialize(
  post: PostRecord,
  acl: { audience: Audience; lounge?: Lounge },
  userId?: number
): RegularPost {
  return {
    id: post.id,
    ownerId: post.ownerId,
    ownerName: post.ownerName,
    text: post.text,
    photos: post.photos.map(photo => {
      const resource = `post-photo/${post.id}/${photo.id}`;
      const base = `/api/media/${resource}`;
      return {
        id: photo.id,
        url:
          acl.audience === "lounge" && userId && process.env.MANUS_JWT_SECRET
            ? `${base}?ticket=${encodeURIComponent(mediaTicket(resource, userId))}`
            : base,
        width: photo.width,
        height: photo.height,
      };
    }),
    destination: post.destination,
    audience: acl.audience,
    ...(post.destination === "lounge"
      ? { loungeId: post.loungeId, loungeName: acl.lounge?.name }
      : {}),
    createdAt: post.createdAt,
    ...(post.updatedAt ? { updatedAt: post.updatedAt } : {}),
  };
}
async function creationFields(
  body: Record<string, unknown>,
  user: User,
  multipart: boolean
): Promise<Fields> {
  known(body, ["text", "destination", "loungeId", "confirmed"]);
  if (body.confirmed !== (multipart ? "true" : true))
    fail(400, "Confirm the displayed audience before posting");
  const text = postText(body.text);
  if (body.destination !== "profile" && body.destination !== "lounge")
    fail(400, "Choose a profile or Lounge destination");
  if (body.destination === "profile") {
    if (body.loungeId !== undefined && body.loungeId !== "")
      fail(400, "Profile posts cannot target a Lounge");
    return { text, destination: "profile", audience: "public" };
  }
  if (
    typeof body.loungeId !== "string" ||
    !body.loungeId ||
    body.loungeId.length > 191
  )
    fail(400, "Choose a Lounge");
  const lounge = await store.get<Lounge>("lounge", body.loungeId);
  if (!lounge || !member(lounge, user.id))
    fail(403, "Join the destination Lounge before posting");
  if (lounge.privacy !== "public" && lounge.privacy !== "private")
    fail(403, "This Lounge cannot accept posts");
  return {
    text,
    destination: "lounge",
    loungeId: lounge.id,
    loungeName: lounge.name,
    audience: lounge.privacy === "private" ? "lounge" : "public",
  };
}
function fingerprint(fields: Fields) {
  return JSON.stringify([
    fields.text,
    fields.destination,
    fields.loungeId,
    fields.audience,
  ]);
}
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: POST_LIMITS.photoBytes,
    files: POST_LIMITS.photos,
    fields: 4,
    parts: 9,
    fieldSize: POST_LIMITS.text * 4,
    fieldNameSize: 100,
  },
  fileFilter(req, file, done) {
    const user = uploadUsers.get(req);
    if (!user) return done(new HttpError(401, "Please sign in"));
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype))
      return done(new HttpError(415, "Upload a JPEG, PNG or WebP photo"));
    // Multer invokes this before memoryStorage accepts the file stream. Fields must precede files.
    void creationFields(object(req.body), user, true).then(
      fields => {
        const current = fingerprint(fields),
          previous = approvedFields.get(req);
        if (previous && previous !== current)
          return done(
            new HttpError(400, "Destination changed during photo upload")
          );
        approvedFields.set(req, current);
        done(null, true);
      },
      error =>
        done(
          error instanceof Error ? error : new HttpError(400, "Invalid post")
        )
    );
  },
}).array("photos", POST_LIMITS.photos);
async function parsePhotos(req: Request, res: Response) {
  try {
    await new Promise<void>((resolve, reject) =>
      photoUpload(req, res, error => (error ? reject(error) : resolve()))
    );
  } catch (error) {
    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE")
        fail(413, "Each photo must be at most 8 MiB");
      fail(
        400,
        error.code === "LIMIT_FILE_COUNT" ||
          error.code === "LIMIT_UNEXPECTED_FILE"
          ? "Use at most four photos in the photos field"
          : "Post form exceeds its limits"
      );
    }
    if (error instanceof HttpError) throw error;
    fail(400, "Invalid multipart post form");
  }
}
function magic(bytes: Buffer): "jpeg" | "png" | "webp" | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
}
function animated(bytes: Buffer, format: string): boolean {
  // Sharp/libvips may expose only the first APNG frame. Inspect actual container chunk boundaries too.
  if (format === "png") {
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(offset),
        kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (kind === "acTL") return true;
      offset += length + 12;
    }
  }
  if (format === "webp") {
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const kind = bytes.toString("ascii", offset, offset + 4),
        length = bytes.readUInt32LE(offset + 4);
      if (
        kind === "ANIM" ||
        kind === "ANMF" ||
        (kind === "VP8X" &&
          length >= 1 &&
          offset + 8 < bytes.length &&
          bytes[offset + 8] & 2)
      )
        return true;
      offset += 8 + length + (length % 2);
    }
  }
  return false;
}
async function sanitize(file: Express.Multer.File) {
  const format = magic(file.buffer);
  if (!format || file.mimetype !== `image/${format}`)
    fail(415, "Photo contents must match JPEG, PNG or WebP");
  if (animated(file.buffer, format))
    fail(415, "Use static photos, not animated images");
  try {
    const image = sharp(file.buffer, {
      limitInputPixels: MAX_PIXELS,
      failOn: "warning",
      animated: true,
    }).timeout({ seconds: 10 });
    const metadata = await image.metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_DIMENSION ||
      metadata.height > MAX_DIMENSION ||
      metadata.width * metadata.height > MAX_PIXELS ||
      (metadata.pages ?? 1) !== 1
    )
      fail(422, "Photo dimensions exceed the static image limits");
    // Sharp strips EXIF, GPS, XMP and ICC metadata by default; rotate honors EXIF before stripping it.
    const output = await image
      .rotate()
      .resize(OUTPUT_DIMENSION, OUTPUT_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (!output.data.length || output.data.length > POST_LIMITS.photoBytes)
      fail(422, "Sanitized photo exceeds the output limit");
    return {
      data: output.data,
      width: output.info.width,
      height: output.info.height,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(
      422,
      "Photo could not be decoded safely; choose a valid JPEG, PNG or WebP"
    );
  }
}
async function readable(id: string, userId?: number) {
  const post = await store.get<PostRecord>("post", id);
  const acl = post ? await access(post, userId) : null;
  if (!post || !acl) fail(404, "Post not found");
  return { post, acl };
}
/** Social interactions use the same current post/Lounge access boundary as photo and post reads. */
export async function assertPostReadable(
  id: string,
  userId?: number
): Promise<{ ownerId: number }> {
  const { post } = await readable(id, userId);
  return { ownerId: post.ownerId };
}
async function author(id: string, user: User) {
  const post = await store.get<PostRecord>("post", id);
  if (!post || post.deletedAt) fail(404, "Post not found");
  if (post.ownerId !== user.id)
    fail(403, "Only the author can change this post");
  if (!(await access(post, user.id))) fail(404, "Post not found");
  return post;
}
async function photoBytes(
  req: Request,
  res: Response,
  postId: string,
  photoId: string,
  userId?: number
) {
  const { post } = await readable(postId, userId);
  const photo = post.photos.find(item => item.id === photoId);
  if (!photo) fail(404, "Photo not found");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);
  const closed = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", closed);
  // Include signing in the deadline even though the existing signing helper has no signal parameter.
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new HttpError(504, "Photo storage timed out"));
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const url = await Promise.race([storageGetSignedUrl(photo.key), aborted]);
    const upstream = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
      headers: {
        Accept: "image/webp",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-store",
      },
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      fail(502, "Stored photo is unavailable");
    }
    const length = upstream.headers.get("content-length");
    const expected = photo.bytes;
    if (
      !Number.isSafeInteger(expected) ||
      expected <= 0 ||
      expected > POST_LIMITS.photoBytes ||
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) !== expected))
    ) {
      await upstream.body.cancel();
      fail(502, "Stored photo exceeds its output limit");
    }
    const reader = upstream.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > expected || size > POST_LIMITS.photoBytes)
          fail(502, "Stored photo exceeds its output limit");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, size);
    if (size !== expected || magic(bytes) !== "webp")
      fail(502, "Stored photo is invalid");
    // Revocation during the bounded fetch also takes effect before any image bytes are sent.
    const current = await readable(postId, userId);
    if (
      !current.post.photos.some(
        item => item.id === photoId && item.key === photo.key
      )
    )
      fail(404, "Photo not found");
    res.set({
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Disposition": 'inline; filename="photo.webp"',
    });
    res.send(bytes);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(
      controller.signal.aborted ? 504 : 502,
      "Photo storage is temporarily unavailable"
    );
  } finally {
    clearTimeout(timeout);
    res.off("close", closed);
    if (abortListener)
      controller.signal.removeEventListener("abort", abortListener);
    controller.abort();
  }
}

export function registerPostRoutes(app: Express) {
  app.get(
    "/api/app/posts",
    route(async (req, res) => {
      const user = await optionalUser(req);
      const loungeId = req.query.loungeId;
      if (loungeId !== undefined) {
        if (typeof loungeId !== "string" || !loungeId || loungeId.length > 191)
          fail(400, "Invalid Lounge filter");
        const lounge = await store.get<Lounge>("lounge", loungeId);
        if (
          !lounge ||
          (lounge.privacy !== "public" && !member(lounge, user?.id))
        )
          fail(404, "Lounge not found");
      }
      const ownerId = req.query.ownerId;
      if (
        ownerId !== undefined &&
        (typeof ownerId !== "string" ||
          !/^[1-9]\d*$/.test(ownerId) ||
          !Number.isSafeInteger(Number(ownerId)))
      )
        fail(400, "Invalid author filter");
      const posts = (await store.list<PostRecord>("post"))
        .filter(
          post =>
            (!loungeId || post.loungeId === loungeId) &&
            (!ownerId || post.ownerId === Number(ownerId))
        )
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
        );
      const result: RegularPost[] = [];
      for (const post of posts) {
        const acl = await access(post, user?.id);
        if (acl) result.push(serialize(post, acl, user?.id));
        if (result.length === 50) break;
      }
      res.json(result);
    })
  );
  app.get(
    "/api/app/posts/:id",
    route(async (req, res) => {
      const user = await optionalUser(req),
        { post, acl } = await readable(req.params.id, user?.id);
      res.json(serialize(post, acl, user?.id));
    })
  );
  app.post(
    "/api/app/posts",
    route(async (req, res) => {
      const user = await needUser(req);
      if (uploadsInFlight >= 2 || uploadOwners.has(user.id))
        fail(429, "Please wait for the current post upload");
      uploadsInFlight++;
      uploadOwners.add(user.id);
      uploadUsers.set(req, user);
      try {
        const multipart = !!req.is("multipart/form-data");
        if (multipart) await parsePhotos(req, res);
        else if (!req.is("application/json"))
          fail(415, "Send a JSON post or multipart photos");
        const body = object(req.body);
        let fields = await creationFields(body, user, multipart);
        const files = (req.files ?? []) as Express.Multer.File[];
        if (files.length && approvedFields.get(req) !== fingerprint(fields))
          fail(400, "Destination changed after photo transfer began");
        if (!fields.text && !files.length)
          fail(400, "Add text or at least one photo");
        const outputs = [];
        // Decode every file before writing any object. Bound CPU/memory by processing sequentially.
        for (const file of files) outputs.push(await sanitize(file));
        const id = randomUUID(),
          photos: PhotoRecord[] = [];
        const originalFields = fingerprint(fields);
        for (const output of outputs) {
          fields = await creationFields(body, user, multipart);
          if (fingerprint(fields) !== originalFields)
            fail(
              409,
              "The destination audience changed; review before posting"
            );
          const photoId = randomUUID();
          const stored = await storagePut(
            `posts/${id}/${photoId}.webp`,
            output.data,
            "image/webp"
          );
          photos.push({
            id: photoId,
            key: stored.key,
            width: output.width,
            height: output.height,
            bytes: output.data.length,
          });
        }
        fields = await creationFields(body, user, multipart);
        if (fingerprint(fields) !== originalFields)
          fail(409, "The destination audience changed; review before posting");
        const post: PostRecord = {
          id,
          ownerId: user.id,
          ownerName: user.name?.trim() || "Member",
          ...fields,
          photos,
          createdAt: new Date().toISOString(),
        };
        await store.create("post", user.id, post);
        const acl = await access(post, user.id);
        if (!acl) fail(404, "Post destination is no longer available");
        res.status(201).json(serialize(post, acl, user.id));
      } finally {
        uploadsInFlight--;
        uploadOwners.delete(user.id);
        uploadUsers.delete(req);
        approvedFields.delete(req);
      }
    })
  );
  app.patch(
    "/api/app/posts/:id",
    route(async (req, res) => {
      const user = await needUser(req),
        body = object(req.body);
      known(body, ["text", "keepPhotoIds", "confirmed"]);
      if (body.confirmed !== true) fail(400, "Confirm this post edit");
      const text = postText(body.text);
      if (
        !Array.isArray(body.keepPhotoIds) ||
        body.keepPhotoIds.length > POST_LIMITS.photos ||
        body.keepPhotoIds.some(id => typeof id !== "string") ||
        new Set(body.keepPhotoIds).size !== body.keepPhotoIds.length
      )
        fail(400, "Choose the existing photos to keep");
      const keep = body.keepPhotoIds as string[];
      await author(req.params.id, user);
      const updated = await store.mutate<PostRecord>(
        "post",
        req.params.id,
        current => {
          if (current.deletedAt) fail(404, "Post not found");
          if (current.ownerId !== user.id)
            fail(403, "Only the author can edit this post");
          if (keep.some(id => !current.photos.some(photo => photo.id === id)))
            fail(400, "Unknown photo in post edit");
          const photos = current.photos.filter(photo =>
            keep.includes(photo.id)
          );
          if (!text && !photos.length)
            fail(400, "Add text or keep at least one photo");
          return {
            ...current,
            text,
            photos,
            updatedAt: new Date().toISOString(),
          };
        }
      );
      const acl = await access(updated, user.id);
      if (!acl) fail(404, "Post not found");
      res.json(serialize(updated, acl, user.id));
    })
  );
  app.delete(
    "/api/app/posts/:id",
    route(async (req, res) => {
      const user = await needUser(req),
        body = object(req.body);
      known(body, ["confirmed"]);
      if (body.confirmed !== true) fail(400, "Confirm deleting this post");
      await author(req.params.id, user);
      await store.mutate<PostRecord>("post", req.params.id, current => {
        if (current.deletedAt) fail(404, "Post not found");
        if (current.ownerId !== user.id)
          fail(403, "Only the author can delete this post");
        return {
          ...current,
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      });
      res.json({ deleted: true });
    })
  );
  app.get(
    "/api/media/post-photo/:postId/:photoId",
    route(async (req, res) => {
      const resource = `post-photo/${req.params.postId}/${req.params.photoId}`;
      const user =
        (await optionalUser(req)) ?? (await ticketUser(req, resource));
      await photoBytes(
        req,
        res,
        req.params.postId,
        req.params.photoId,
        user?.id
      );
    })
  );
}
