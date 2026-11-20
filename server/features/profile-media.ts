import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express, Request, Response } from "express";
import multer from "multer";
import sharp from "sharp";
import {
  PROFILE_LIMITS,
  canViewProfile,
  type Profile,
  type ProfileAsset,
} from "../../shared/profile-types";
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
import { command } from "./processing";
import * as store from "./store";

export type ProfileRecord = Omit<Profile, "media" | "worldMedia"> & { id: string };
export const PROFILE_SLOTS = [
  "avatar",
  "banner",
  "background",
  "ghost",
] as const;
export type ProfileSlot = (typeof PROFILE_SLOTS)[number];
export type ProfileMediaRecord = {
  id: string;
  ownerId: number;
  slot: ProfileSlot;
  kind: "image" | "video";
  objectKey: string;
  bytes: number;
  width: number;
  height: number;
  duration?: number;
  posterKey?: string;
  posterBytes?: number;
  createdAt: string;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validAssetId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
export function mediaMatches(
  asset: ProfileMediaRecord | undefined,
  ownerId: number,
  slot: ProfileSlot
): asset is ProfileMediaRecord {
  return (
    !!asset &&
    validAssetId(asset.id) &&
    Number.isSafeInteger(ownerId) &&
    ownerId > 0 &&
    PROFILE_SLOTS.includes(slot) &&
    asset.ownerId === ownerId &&
    asset.slot === slot &&
    (asset.kind === "image" ||
      (slot === "background" && asset.kind === "video")) &&
    typeof asset.objectKey === "string" &&
    !!asset.objectKey &&
    Number.isSafeInteger(asset.bytes) &&
    asset.bytes > 0 &&
    asset.bytes <=
      (asset.kind === "image"
        ? PROFILE_LIMITS.imageBytes
        : PROFILE_LIMITS.videoBytes) &&
    Number.isSafeInteger(asset.width) &&
    Number.isSafeInteger(asset.height) &&
    asset.width > 0 &&
    asset.height > 0 &&
    asset.width <= (asset.kind === "image" ? 2048 : 1280) &&
    asset.height <= (asset.kind === "image" ? 2048 : 720) &&
    (asset.kind !== "video" ||
      (typeof asset.duration === "number" &&
        Number.isFinite(asset.duration) &&
        asset.duration > 0 &&
        asset.duration <= PROFILE_LIMITS.videoSeconds &&
        typeof asset.posterKey === "string" &&
        !!asset.posterKey &&
        Number.isSafeInteger(asset.posterBytes) &&
        asset.posterBytes! > 0 &&
        asset.posterBytes! <= PROFILE_LIMITS.imageBytes))
  );
}
function referenced(
  profile: ProfileRecord | undefined,
  asset: ProfileMediaRecord
): boolean {
  return (
    !!profile &&
    profile.id === `profile:${asset.ownerId}` &&
    profile.ownerId === asset.ownerId &&
    profile.saved === true &&
    profile[`${asset.slot}MediaId`] === asset.id
  );
}
export function profileAsset(
  asset: ProfileMediaRecord,
  viewerId?: number,
  publiclyReadable = false
): ProfileAsset {
  const url = (poster = false) => {
    const resource = `profile/${asset.id}${poster ? "/poster" : ""}`;
    const base = `/api/media/${resource}`;
    return !publiclyReadable && viewerId && process.env.MANUS_JWT_SECRET
      ? `${base}?ticket=${encodeURIComponent(mediaTicket(resource, viewerId))}`
      : base;
  };
  return {
    id: asset.id,
    kind: asset.kind,
    width: asset.width,
    height: asset.height,
    url: url(),
    ...(asset.kind === "video"
      ? {
          duration: asset.duration,
          posterUrl: asset.posterKey ? url(true) : undefined,
        }
      : {}),
  };
}
function imageMagic(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
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
function animated(bytes: Buffer, format: string) {
  if (format === "png") {
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
        return true;
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
          length > 0 &&
          offset + 8 < bytes.length &&
          bytes[offset + 8] & 2)
      )
        return true;
      offset += 8 + length + (length % 2);
    }
  }
  return false;
}
/** Native decode/re-encode; no user metadata, executable formats or animations survive. */
export async function sanitizeProfileImage(bytes: Buffer, mime: string) {
  if (!bytes.length || bytes.length > PROFILE_LIMITS.imageBytes)
    fail(413, "Profile images must be at most 8 MiB");
  const format = imageMagic(bytes);
  if (!format || mime !== `image/${format}` || animated(bytes, format))
    fail(415, "Choose a static JPEG, PNG or WebP with matching contents");
  try {
    const image = sharp(bytes, {
      limitInputPixels: 24_000_000,
      failOn: "warning",
      animated: true,
    }).timeout({ seconds: 10 });
    const meta = await image.metadata();
    if (
      meta.format !== format ||
      !meta.width ||
      !meta.height ||
      meta.width > 16_384 ||
      meta.height > 16_384 ||
      meta.width * meta.height > 24_000_000 ||
      (meta.pages ?? 1) !== 1
    )
      fail(422, "Profile image dimensions exceed the static image limits");
    const result = await image
      .rotate()
      .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (!result.data.length || result.data.length > PROFILE_LIMITS.imageBytes)
      fail(422, "Processed profile image exceeds its size limit");
    return {
      data: result.data,
      width: result.info.width,
      height: result.info.height,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(422, "Profile image could not be decoded safely");
  }
}
type VideoInfo = {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  duration: number;
  audio: boolean;
  codec: string;
  pixelFormat: string;
  container: string;
};
async function inspectVideo(
  file: string,
  signal: AbortSignal
): Promise<VideoInfo> {
  const result = JSON.parse(
    await command(
      "ffprobe",
      [
        "-v",
        "error",
        "-threads",
        "2",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file,
      ],
      signal,
      10_000
    )
  );
  const videos = (result.streams ?? []).filter(
    (s: any) => s.codec_type === "video"
  );
  const video = videos[0];
  if (videos.length !== 1 || video.disposition?.attached_pic)
    fail(422, "Choose a single readable video stream");
  let width = Number(video.width),
    height = Number(video.height);
  const sar = /^(\d+):(\d+)$/.exec(video.sample_aspect_ratio ?? "1:1");
  const pixelAspect =
    sar && Number(sar[1]) > 0 && Number(sar[2]) > 0
      ? Number(sar[1]) / Number(sar[2])
      : 1;
  if (!Number.isFinite(pixelAspect) || pixelAspect < 0.01 || pixelAspect > 100)
    fail(422, "Unsupported video pixel aspect ratio");
  let displayWidth = width * pixelAspect,
    displayHeight = height;
  const rotation = Number(
    video.tags?.rotate ??
      video.side_data_list?.find((s: any) => s.rotation !== undefined)
        ?.rotation ??
      0
  );
  if (!Number.isFinite(rotation) || rotation % 90 !== 0)
    fail(422, "Invalid video rotation");
  if (Math.abs(rotation) % 180 === 90) {
    [width, height] = [height, width];
    [displayWidth, displayHeight] = [displayHeight, displayWidth];
  }
  const duration = Number(result.format?.duration ?? video.duration);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 24_000_000 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > PROFILE_LIMITS.videoSeconds
  )
    fail(
      422,
      "Background video must be at most 30 seconds and within safe dimensions"
    );
  return {
    width,
    height,
    displayWidth,
    displayHeight,
    duration,
    audio: result.streams.some((s: any) => s.codec_type === "audio"),
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    container: String(result.format?.format_name ?? ""),
  };
}
async function containerHeader(file: string, mime: string) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4096),
      { bytesRead } = await handle.read(buffer, 0, buffer.length, 0),
      bytes = buffer.subarray(0, bytesRead);
    if (mime === "video/webm") {
      // EBML DocType distinguishes WebM from arbitrary Matroska, which shares its demuxer.
      return (
        bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
        bytes.indexOf(
          Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])
        ) >= 0
      );
    }
    if (mime !== "video/mp4") return false;
    for (let offset = 0; offset + 16 <= bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      if (length < 8 || offset + length > bytes.length) break;
      if (bytes.toString("ascii", offset + 4, offset + 8) === "ftyp") {
        const brands = [bytes.toString("ascii", offset + 8, offset + 12)];
        for (let brand = offset + 16; brand + 4 <= offset + length; brand += 4)
          brands.push(bytes.toString("ascii", brand, brand + 4));
        return (
          brands.some(brand =>
            /^(isom|iso[2-9]|mp4[12]|avc[1-4]|dash|M4V |MSNV|hvc1|hev1|av01)$/.test(
              brand
            )
          ) && brands[0] !== "qt  "
        );
      }
      offset += length;
    }
    return false;
  } finally {
    await handle.close();
  }
}
/** Real probe both before and after conversion. Scratch paths are generated by the application. */
export async function processProfileVideo(
  input: string,
  directory: string,
  mime: string,
  signal = AbortSignal.timeout(90_000)
) {
  if ((await stat(input)).size > PROFILE_LIMITS.videoBytes)
    fail(413, "Background videos must be at most 20 MiB");
  try {
    signal.throwIfAborted();
    if (!(await containerHeader(input, mime)))
      fail(415, "Video contents must match MP4 or WebM");
    const source = await inspectVideo(input, signal);
    if (
      (mime === "video/mp4" && !source.container.split(",").includes("mp4")) ||
      (mime === "video/webm" &&
        (!source.container.split(",").includes("webm") ||
          !["vp8", "vp9", "av1"].includes(source.codec)))
    )
      fail(415, "Video contents must match MP4 or WebM");
    const output = path.join(directory, "background.mp4"),
      poster = path.join(directory, "poster.webp");
    const scale = Math.min(
      1,
      1280 / source.displayWidth,
      720 / source.displayHeight
    );
    const width = Math.max(
        2,
        Math.floor((source.displayWidth * scale) / 2) * 2
      ),
      height = Math.max(2, Math.floor((source.displayHeight * scale) / 2) * 2);
    const common = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-threads",
      "2",
      "-filter_threads",
      "1",
      "-protocol_whitelist",
      "file,pipe",
    ];
    await command(
      "ffmpeg",
      [
        ...common,
        "-format_whitelist",
        "mov,matroska,webm",
        "-i",
        input,
        "-t",
        String(PROFILE_LIMITS.videoSeconds),
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        `scale=${width}:${height},setsar=1,fps=30`,
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-preset",
        "veryfast",
        "-crf",
        "26",
        "-maxrate",
        "2500k",
        "-bufsize",
        "5000k",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-fs",
        String(PROFILE_LIMITS.videoBytes),
        output,
      ],
      signal,
      60_000
    );
    const normalized = await inspectVideo(output, signal);
    if (
      normalized.codec !== "h264" ||
      normalized.pixelFormat !== "yuv420p" ||
      normalized.audio ||
      normalized.width > 1280 ||
      normalized.height > 720 ||
      Math.abs(source.duration - normalized.duration) > 0.15
    )
      fail(422, "Background video could not be normalized safely");
    await command(
      "ffmpeg",
      [
        ...common,
        "-i",
        output,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=640:640:force_original_aspect_ratio=decrease",
        "-c:v",
        "libwebp",
        "-threads",
        "2",
        "-q:v",
        "80",
        "-fs",
        String(PROFILE_LIMITS.imageBytes),
        poster,
      ],
      signal,
      15_000
    );
    const outputSize = (await stat(output)).size,
      posterSize = (await stat(poster)).size;
    if (
      !outputSize ||
      outputSize > PROFILE_LIMITS.videoBytes ||
      !posterSize ||
      posterSize > PROFILE_LIMITS.imageBytes
    )
      fail(422, "Processed media exceeds its size limit");
    const data = await readFile(output),
      posterData = await readFile(poster);
    if (imageMagic(posterData) !== "webp")
      fail(422, "Video poster could not be created");
    return {
      data,
      posterData,
      width: normalized.width,
      height: normalized.height,
      duration: normalized.duration,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(
      422,
      "Background video could not be decoded within safe processing limits"
    );
  }
}
const uploadOwners = new Set<number>();
const directories = new WeakMap<Request, string>();
const approvedSlots = new WeakMap<Request, ProfileSlot>();
function uploadFields(body: any): ProfileSlot {
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).some(key => !["slot", "confirmed"].includes(key)) ||
    body.confirmed !== "true" ||
    !PROFILE_SLOTS.includes(body.slot)
  )
    fail(400, "Send a valid slot and confirmed=true before the file");
  return body.slot;
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, done) => done(null, directories.get(req)!),
    filename: (_req, _file, done) => done(null, "input.media"),
  }),
  limits: {
    files: 1,
    fileSize: PROFILE_LIMITS.videoBytes,
    fields: 2,
    parts: 3,
    fieldSize: 64,
    fieldNameSize: 32,
  },
  fileFilter(req, file, done) {
    try {
      if (!directories.has(req)) fail(401, "Please sign in");
      const slot = uploadFields(req.body);
      if (
        !["image/jpeg", "image/png", "image/webp"].includes(file.mimetype) &&
        !(
          slot === "background" &&
          ["video/mp4", "video/webm"].includes(file.mimetype)
        )
      )
        fail(
          415,
          "Choose a static JPEG, PNG or WebP; only backgrounds accept MP4/WebM"
        );
      approvedSlots.set(req, slot);
      done(null, true);
    } catch (error) {
      done(error as Error);
    }
  },
}).single("file");
async function readableAsset(id: string, userId?: number) {
  if (!validAssetId(id)) fail(404, "Profile media not found");
  const asset = await store.get<ProfileMediaRecord>("profile-media", id);
  if (
    !asset ||
    asset.id !== id ||
    !mediaMatches(asset, asset.ownerId, asset.slot)
  )
    fail(404, "Profile media not found");
  if (asset.ownerId === userId) return asset; // Drafts can predate the owner's first profile save.
  const profile = await store.get<ProfileRecord>(
    "profile",
    `profile:${asset.ownerId}`
  );
  if (
    !referenced(profile, asset) ||
    !profile?.settings ||
    !canViewProfile(profile, userId)
  )
    fail(404, "Profile media not found");
  return asset;
}
function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]))
    fail(416, "Only one valid byte range is supported");
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      fail(416, "Invalid byte range");
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(end)) fail(416, "Invalid byte range");
    end = Math.min(size - 1, end);
  }
  if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start)
    fail(416, "Byte range is outside this file");
  return { start, end };
}
async function deliver(req: Request, res: Response, poster: boolean) {
  const id = req.params.assetId,
    resource = `profile/${id}${poster ? "/poster" : ""}`;
  const user = (await optionalUser(req)) ?? (await ticketUser(req, resource));
  const asset = await readableAsset(id, user?.id);
  const key = poster ? asset.posterKey : asset.objectKey;
  const size = poster ? asset.posterBytes : asset.bytes;
  const mime = poster || asset.kind === "image" ? "image/webp" : "video/mp4";
  const limit =
    mime === "video/mp4"
      ? PROFILE_LIMITS.videoBytes
      : PROFILE_LIMITS.imageBytes;
  if (!key || !Number.isSafeInteger(size) || !size || size > limit || size < 0)
    fail(404, "Profile media not found");
  let range: { start: number; end: number } | undefined;
  if (mime === "video/mp4" && req.get("range")) {
    try {
      range = byteRange(req.get("range")!, size);
    } catch (error) {
      res.set("Content-Range", `bytes */${size}`);
      throw error;
    }
  }
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 10_000);
  const closed = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", closed);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () =>
      reject(new HttpError(504, "Profile media storage timed out"));
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const url = await Promise.race([storageGetSignedUrl(key), aborted]);
    const upstream = await fetch(url, {
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
      headers: {
        Accept: mime,
        "Accept-Encoding": "identity",
        "Cache-Control": "no-store",
      },
    });
    if (upstream.status !== 200 || !upstream.body) {
      await upstream.body?.cancel();
      fail(502, "Stored profile media is unavailable");
    }
    const length = upstream.headers.get("content-length");
    if (
      (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) ||
      (upstream.headers.get("content-encoding") &&
        upstream.headers.get("content-encoding") !== "identity")
    ) {
      await upstream.body.cancel();
      fail(502, "Stored profile media exceeds its output limit");
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > size || received > limit)
          fail(502, "Stored profile media exceeds its output limit");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, received);
    if (
      received !== size ||
      (mime === "image/webp"
        ? imageMagic(bytes) !== "webp"
        : bytes.toString("ascii", 4, 8) !== "ftyp")
    )
      fail(502, "Stored profile media is invalid");
    // Tickets identify a viewer, not a permanent grant: current visibility and references always win.
    const current = await readableAsset(id, user?.id);
    if (
      current.objectKey !== asset.objectKey ||
      current.posterKey !== asset.posterKey ||
      current.bytes !== asset.bytes ||
      current.posterBytes !== asset.posterBytes ||
      current.ownerId !== asset.ownerId ||
      current.slot !== asset.slot ||
      current.kind !== asset.kind
    )
      fail(404, "Profile media not found");
    const output = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    res.status(range ? 206 : 200).set({
      "Content-Type": mime,
      "Content-Length": String(output.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Disposition": `inline; filename="profile.${mime === "video/mp4" ? "mp4" : "webp"}"`,
    });
    if (mime === "video/mp4") res.set("Accept-Ranges", "bytes");
    if (range)
      res.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    res.send(output);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(
      controller.signal.aborted ? 504 : 502,
      "Profile media storage is temporarily unavailable"
    );
  } finally {
    clearTimeout(timeout);
    res.off("close", closed);
    if (abortListener)
      controller.signal.removeEventListener("abort", abortListener);
    controller.abort();
  }
}
export function registerProfileMediaRoutes(app: Express) {
  app.get(
    "/api/app/profile/media/:assetId",
    route(async (req, res) => {
      const user = await optionalUser(req);
      const asset = await readableAsset(req.params.assetId, user?.id);
      // Renew only for the current viewer: owner-only drafts and current visibility still apply.
      await readableAsset(asset.id, user?.id);
      res.json(profileAsset(asset, user?.id));
    })
  );
  app.post(
    "/api/app/profile/media",
    route(async (req, res) => {
      const user = await needUser(req);
      if (uploadOwners.size >= 2 || uploadOwners.has(user.id))
        fail(429, "Please wait for the current profile upload");
      if (!req.is("multipart/form-data"))
        fail(415, "Send a multipart profile media form");
      uploadOwners.add(user.id);
      let directory: string | undefined;
      try {
        directory = await mkdtemp(path.join(tmpdir(), "respawn-profile-"));
        directories.set(req, directory);
        try {
          await new Promise<void>((resolve, reject) =>
            upload(req, res, error => (error ? reject(error) : resolve()))
          );
        } catch (error) {
          if (error instanceof multer.MulterError)
            fail(
              error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
              "Profile media form exceeds its limits"
            );
          if (error instanceof HttpError) throw error;
          fail(400, "Invalid profile media form");
        }
        const slot = uploadFields(req.body);
        if (!req.file) fail(400, "Choose a profile media file");
        if (approvedSlots.get(req) !== slot)
          fail(400, "Profile media slot changed during upload");
        const video = req.file.mimetype.startsWith("video/");
        if (
          req.file.size >
          (video ? PROFILE_LIMITS.videoBytes : PROFILE_LIMITS.imageBytes)
        )
          fail(
            413,
            "Profile image must be at most 8 MiB; video at most 20 MiB"
          );
        const result = video
          ? await processProfileVideo(
              req.file.path,
              directory,
              req.file.mimetype
            )
          : await sanitizeProfileImage(
              await readFile(req.file.path),
              req.file.mimetype
            );
        const id = randomUUID(),
          stored = await storagePut(
            `profiles/${user.id}/${id}.${video ? "mp4" : "webp"}`,
            result.data,
            video ? "video/mp4" : "image/webp"
          );
        const asset: ProfileMediaRecord = {
          id,
          ownerId: user.id,
          slot,
          kind: video ? "video" : "image",
          objectKey: stored.key,
          bytes: result.data.length,
          width: result.width,
          height: result.height,
          createdAt: new Date().toISOString(),
        };
        if ("posterData" in result) {
          const poster = await storagePut(
            `profiles/${user.id}/${id}-poster.webp`,
            result.posterData,
            "image/webp"
          );
          asset.duration = result.duration;
          asset.posterKey = poster.key;
          asset.posterBytes = result.posterData.length;
        }
        await store.create("profile-media", user.id, asset);
        res.status(201).json(profileAsset(asset, user.id));
      } finally {
        uploadOwners.delete(user.id);
        directories.delete(req);
        approvedSlots.delete(req);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    })
  );
  app.get(
    "/api/media/profile/:assetId/poster",
    route((req, res) => deliver(req, res, true))
  );
  app.get(
    "/api/media/profile/:assetId",
    route((req, res) => deliver(req, res, false))
  );
}
