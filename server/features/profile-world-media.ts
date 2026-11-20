import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Express, Request, Response } from "express";
import multer from "multer";
import { canViewProfile } from "../../shared/profile-types";
import {
  WORLD_LIMITS,
  type WorldAsset,
} from "../../shared/profile-world-types";
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
import {
  sanitizeProfileImage,
  validAssetId,
  type ProfileRecord,
} from "./profile-media";
import { command } from "./processing";
import * as store from "./store";

export type WorldMediaRecord = {
  id: string;
  ownerId: number;
  slot: "art" | "music";
  kind: "image" | "audio";
  objectKey: string;
  bytes: number;
  width?: number;
  height?: number;
  duration?: number;
  createdAt: string;
};
export function worldMediaMatches(
  asset: WorldMediaRecord | undefined,
  ownerId: number,
  kind: WorldAsset["kind"]
): asset is WorldMediaRecord {
  return (
    !!asset &&
    validAssetId(asset.id) &&
    Number.isSafeInteger(ownerId) &&
    ownerId > 0 &&
    (kind === "audio" || kind === "image") &&
    asset.ownerId === ownerId &&
    asset.kind === kind &&
    asset.slot === (kind === "audio" ? "music" : "art") &&
    !(asset as WorldMediaRecord & { deletedAt?: string }).deletedAt &&
    typeof asset.objectKey === "string" &&
    !!asset.objectKey &&
    Number.isSafeInteger(asset.bytes) &&
    asset.bytes > 0 &&
    asset.bytes <=
      (kind === "audio" ? WORLD_LIMITS.audioBytes : WORLD_LIMITS.imageBytes) &&
    (kind === "audio"
      ? typeof asset.duration === "number" &&
        Number.isFinite(asset.duration) &&
        asset.duration > 0 &&
        asset.duration <= WORLD_LIMITS.audioSeconds
      : Number.isSafeInteger(asset.width) &&
        Number.isSafeInteger(asset.height) &&
        asset.width! > 0 &&
        asset.height! > 0 &&
        asset.width! <= 2048 &&
        asset.height! <= 2048)
  );
}
export function worldReferenced(
  profile: ProfileRecord | undefined,
  asset: WorldMediaRecord
): boolean {
  if (
    !profile ||
    profile.id !== `profile:${asset.ownerId}` ||
    profile.ownerId !== asset.ownerId ||
    profile.saved !== true ||
    (profile as ProfileRecord & { deletedAt?: string }).deletedAt
  )
    return false;
  const entries =
    asset.kind === "audio" ? profile.world?.music : profile.world?.art;
  return (
    Array.isArray(entries) && entries.some(entry => entry?.mediaId === asset.id)
  );
}
export function worldAsset(
  asset: WorldMediaRecord,
  viewerId?: number,
  publiclyReadable = false
): WorldAsset {
  const resource = `profile-world/${asset.id}`;
  const base = `/api/media/${resource}`;
  return {
    id: asset.id,
    kind: asset.kind,
    url:
      !publiclyReadable && viewerId && process.env.MANUS_JWT_SECRET
        ? `${base}?ticket=${encodeURIComponent(mediaTicket(resource, viewerId))}`
        : base,
    ...(asset.kind === "audio"
      ? { duration: asset.duration }
      : { width: asset.width, height: asset.height }),
  };
}
const AUDIO_MIMES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
];
type AudioContainer = "mp3" | "wav" | "mov" | "ogg";
function mp3Frame(bytes: Buffer, offset = 0) {
  if (offset + 4 > bytes.length) return false;
  const a = bytes[offset],
    b = bytes[offset + 1],
    c = bytes[offset + 2];
  return (
    a === 0xff &&
    (b & 0xe0) === 0xe0 &&
    (b & 0x18) !== 0x08 &&
    (b & 0x06) === 0x02 &&
    (c & 0xf0) !== 0 &&
    (c & 0xf0) !== 0xf0 &&
    (c & 0x0c) !== 0x0c
  );
}
/** Container signatures are checked before even invoking ffprobe. No playlists or guessed demuxers. */
async function audioContainer(
  file: string,
  mime: string
): Promise<AudioContainer | undefined> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const header = Buffer.alloc(Math.min(4096, size));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (mime === "audio/mpeg") {
      if (mp3Frame(bytes)) return "mp3";
      if (
        bytes.length >= 10 &&
        bytes.toString("ascii", 0, 3) === "ID3" &&
        [2, 3, 4].includes(bytes[3]) &&
        bytes[4] !== 0xff &&
        [...bytes.subarray(6, 10)].every(value => value < 128)
      ) {
        const length =
          (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
        const offset =
          10 + length + (bytes[3] === 4 && bytes[5] & 0x10 ? 10 : 0);
        if (offset + 4 <= size) {
          const frame = Buffer.alloc(4);
          await handle.read(frame, 0, 4, offset);
          if (mp3Frame(frame)) return "mp3";
        }
      }
    }
    if (
      ["audio/wav", "audio/x-wav"].includes(mime) &&
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WAVE"
    )
      return "wav";
    if (
      mime === "audio/ogg" &&
      bytes.length >= 28 &&
      bytes.toString("ascii", 0, 4) === "OggS" &&
      bytes[4] === 0 &&
      (bytes.indexOf(Buffer.from("OpusHead")) >= 27 ||
        bytes.indexOf(Buffer.from([1, 118, 111, 114, 98, 105, 115])) >= 27)
    )
      return "ogg";
    if (["audio/mp4", "audio/x-m4a"].includes(mime)) {
      for (let offset = 0; offset + 16 <= bytes.length; ) {
        const length = bytes.readUInt32BE(offset);
        if (length < 8 || offset + length > bytes.length) break;
        if (bytes.toString("ascii", offset + 4, offset + 8) === "ftyp") {
          const brands = [bytes.toString("ascii", offset + 8, offset + 12)];
          for (
            let position = offset + 16;
            position + 4 <= offset + length;
            position += 4
          )
            brands.push(bytes.toString("ascii", position, position + 4));
          if (
            brands[0] !== "qt  " &&
            brands.some(brand => /^(M4A |isom|iso[2-9]|mp4[12])$/.test(brand))
          )
            return "mov";
          return;
        }
        offset += length;
      }
    }
  } finally {
    await handle.close();
  }
}
async function inspectAudio(
  file: string,
  container: AudioContainer,
  signal: AbortSignal
) {
  const result = JSON.parse(
    await command(
      "ffprobe",
      [
        "-v",
        "error",
        "-threads",
        "2",
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        container,
        "-f",
        container,
        ...(container === "mov"
          ? ["-enable_drefs", "0", "-use_absolute_path", "0"]
          : []),
        "-show_format",
        "-show_streams",
        "-show_chapters",
        "-of",
        "json",
        file,
      ],
      signal,
      10_000
    )
  );
  const streams = result.streams;
  if (
    !Array.isArray(streams) ||
    streams.length !== 1 ||
    streams[0].codec_type !== "audio" ||
    streams[0].disposition?.attached_pic
  )
    fail(
      422,
      "Choose an audio-only file with one audio stream and no movie or artwork streams"
    );
  const stream = streams[0];
  const duration = Number(result.format?.duration ?? stream.duration);
  const sampleRate = Number(stream.sample_rate),
    channels = Number(stream.channels);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > WORLD_LIMITS.audioSeconds ||
    !Number.isSafeInteger(channels) ||
    channels < 1 ||
    channels > 8 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000
  )
    fail(
      422,
      "Music must be readable audio of at most 10 minutes within safe audio limits"
    );
  if (
    (container === "mp3" && stream.codec_name !== "mp3") ||
    (container === "ogg" && !["vorbis", "opus"].includes(stream.codec_name)) ||
    (container === "mov" &&
      !["aac", "alac", "mp3"].includes(stream.codec_name)) ||
    (container === "wav" && !String(stream.codec_name).startsWith("pcm_"))
  )
    fail(415, "Choose MP3, WAV, M4A or OGG audio with matching contents");
  return {
    duration,
    codec: String(stream.codec_name),
    bitRate: Number(stream.bit_rate),
    result,
  };
}
/** Real local decode and re-encode, stripping user metadata/chapters and enforcing bounds before and after. */
export async function processWorldAudio(
  input: string,
  directory: string,
  mime: string,
  signal = AbortSignal.timeout(90_000)
) {
  const size = (await stat(input)).size;
  if (!size || size > WORLD_LIMITS.audioBytes)
    fail(413, "Music files must be at most 15 MiB");
  try {
    signal.throwIfAborted();
    const container = await audioContainer(input, mime);
    if (!container)
      fail(
        415,
        "Music contents must match MP3, WAV, M4A or OGG; playlists are not supported"
      );
    const source = await inspectAudio(input, container, signal);
    const output = path.join(directory, "normalized.mp3");
    await command(
      "ffmpeg",
      [
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
        "file",
        "-format_whitelist",
        container,
        "-f",
        container,
        ...(container === "mov"
          ? ["-enable_drefs", "0", "-use_absolute_path", "0"]
          : []),
        "-i",
        input,
        "-t",
        String(Math.min(source.duration, WORLD_LIMITS.audioSeconds - 0.1)),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-threads",
        "2",
        "-b:a",
        "128k",
        "-id3v2_version",
        "0",
        "-write_id3v1",
        "0",
        "-write_xing",
        "0",
        "-f",
        "mp3",
        "-fs",
        String(WORLD_LIMITS.audioBytes),
        output,
      ],
      signal,
      60_000
    );
    const outputSize = (await stat(output)).size;
    if (!outputSize || outputSize > WORLD_LIMITS.audioBytes)
      fail(422, "Normalized music exceeds its size limit");
    const normalized = await inspectAudio(output, "mp3", signal);
    if (
      normalized.codec !== "mp3" ||
      normalized.bitRate !== 128000 ||
      Math.abs(normalized.duration - source.duration) > 0.2 ||
      normalized.result.chapters?.length ||
      Object.keys(normalized.result.format?.tags ?? {}).length ||
      Object.keys(normalized.result.streams[0].tags ?? {}).length
    )
      fail(422, "Music could not be normalized safely");
    const data = await readFile(output);
    if (!mp3Frame(data)) fail(422, "Normalized music is invalid");
    return { data, duration: normalized.duration };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(422, "Music could not be decoded within safe processing limits");
  }
}

const uploadOwners = new Set<number>();
const directories = new WeakMap<Request, string>();
const approvedSlots = new WeakMap<Request, "art" | "music">();
const uploadSignals = new WeakMap<Request, AbortSignal>();
function uploadFields(body: any): "art" | "music" {
  if (
    !body ||
    typeof body !== "object" ||
    Object.keys(body).some(
      key => !["slot", "confirmed", "rightsConfirmed"].includes(key)
    ) ||
    body.confirmed !== "true" ||
    !["art", "music"].includes(body.slot) ||
    (body.slot === "music" && body.rightsConfirmed !== "true") ||
    (body.rightsConfirmed !== undefined && body.rightsConfirmed !== "true")
  )
    fail(
      400,
      "Send slot, confirmed=true and music rightsConfirmed=true before the file"
    );
  return body.slot;
}
const upload = multer({
  storage: {
    _handleFile(req, file, done) {
      const destination = directories.get(req)!;
      const filename = "input.media",
        filePath = path.join(destination, filename);
      const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
      pipeline(file.stream, output, { signal: uploadSignals.get(req) }).then(
        () =>
          done(null, {
            destination,
            filename,
            path: filePath,
            size: output.bytesWritten,
          }),
        error => done(error)
      );
    },
    _removeFile(_req, file, done) {
      unlink(file.path).then(
        () => done(null),
        error => done(error.code === "ENOENT" ? null : error)
      );
    },
  },
  limits: {
    files: 1,
    fileSize: WORLD_LIMITS.audioBytes,
    fields: 3,
    parts: 4,
    fieldSize: 64,
    fieldNameSize: 32,
  },
  fileFilter(req, file, done) {
    try {
      if (!directories.has(req)) fail(401, "Please sign in");
      const slot = uploadFields(req.body);
      if (
        !(
          slot === "music"
            ? AUDIO_MIMES
            : ["image/jpeg", "image/png", "image/webp"]
        ).includes(file.mimetype)
      )
        fail(
          415,
          "Choose static JPEG, PNG or WebP art; MP3, WAV, M4A or OGG music"
        );
      approvedSlots.set(req, slot);
      done(null, true);
    } catch (error) {
      done(error as Error);
    }
  },
}).single("file");
async function readableAsset(id: string, userId?: number) {
  if (!validAssetId(id)) fail(404, "World media not found");
  const asset = await store.get<WorldMediaRecord>("profile-world-media", id);
  if (
    !asset ||
    asset.id !== id ||
    !worldMediaMatches(asset, asset.ownerId, asset.kind)
  )
    fail(404, "World media not found");
  if (asset.ownerId === userId) return asset;
  const profile = await store.get<ProfileRecord>(
    "profile",
    `profile:${asset.ownerId}`
  );
  if (
    !worldReferenced(profile, asset) ||
    !profile?.settings ||
    !canViewProfile(profile, userId)
  )
    fail(404, "World media not found");
  return asset;
}
function sameAsset(left: WorldMediaRecord, right: WorldMediaRecord) {
  return (
    left.id === right.id &&
    left.ownerId === right.ownerId &&
    left.kind === right.kind &&
    left.slot === right.slot &&
    left.objectKey === right.objectKey &&
    left.bytes === right.bytes &&
    left.duration === right.duration &&
    left.width === right.width &&
    left.height === right.height
  );
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
function webpMagic(bytes: Buffer) {
  return (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}
async function deliver(req: Request, res: Response) {
  const id = req.params.assetId;
  const user =
    (await optionalUser(req)) ?? (await ticketUser(req, `profile-world/${id}`));
  const asset = await readableAsset(id, user?.id);
  const size = asset.bytes,
    audio = asset.kind === "audio",
    mime = audio ? "audio/mpeg" : "image/webp";
  const limit = audio ? WORLD_LIMITS.audioBytes : WORLD_LIMITS.imageBytes;
  let range: { start: number; end: number } | undefined;
  if (audio && req.get("range")) {
    try {
      range = byteRange(req.get("range")!, size);
    } catch (error) {
      res.set("Content-Range", `bytes */${size}`);
      throw error;
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const closed = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", closed);
  let abortListener!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () =>
      reject(new HttpError(504, "World media storage timed out"));
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });
  const bounded = <T>(work: Promise<T>) => Promise.race([work, aborted]);
  try {
    const url = await bounded(storageGetSignedUrl(asset.objectKey));
    const upstream = await bounded(
      fetch(url, {
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        headers: {
          Accept: mime,
          "Accept-Encoding": "identity",
          "Cache-Control": "no-store",
        },
      })
    );
    if (upstream.status !== 200 || !upstream.body) {
      await upstream.body?.cancel();
      fail(502, "Stored world media is unavailable");
    }
    const length = upstream.headers.get("content-length");
    if (
      (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) ||
      (upstream.headers.get("content-encoding") &&
        upstream.headers.get("content-encoding") !== "identity")
    ) {
      await upstream.body.cancel();
      fail(502, "Stored world media exceeds its output limit");
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await bounded(reader.read());
        if (done) break;
        received += value.byteLength;
        if (received > size || received > limit)
          fail(502, "Stored world media exceeds its output limit");
        chunks.push(Buffer.from(value));
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, received);
    if (received !== size || !(audio ? mp3Frame(bytes) : webpMagic(bytes)))
      fail(502, "Stored world media is invalid");
    // A ticket is identity, never a permanent grant; changes during signing/streaming revoke output.
    const current = await bounded(readableAsset(id, user?.id));
    if (!sameAsset(asset, current)) fail(404, "World media not found");
    const output = range ? bytes.subarray(range.start, range.end + 1) : bytes;
    res.status(range ? 206 : 200).set({
      "Content-Type": mime,
      "Content-Length": String(output.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Disposition": `inline; filename="profile-world.${audio ? "mp3" : "webp"}"`,
    });
    if (audio) res.set("Accept-Ranges", "bytes");
    if (range)
      res.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    res.send(output);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(
      controller.signal.aborted ? 504 : 502,
      "World media storage is temporarily unavailable"
    );
  } finally {
    clearTimeout(timeout);
    res.off("close", closed);
    controller.signal.removeEventListener("abort", abortListener);
    controller.abort();
  }
}
export function registerWorldMediaRoutes(app: Express) {
  app.get(
    "/api/app/profile/world/media/:assetId",
    route(async (req, res) => {
      // Metadata always needs a session for drafts/member media: media tickets are not metadata credentials.
      const user = await optionalUser(req);
      const asset = await readableAsset(req.params.assetId, user?.id);
      const current = await readableAsset(asset.id, user?.id);
      if (!sameAsset(asset, current)) fail(404, "World media not found");
      res.json(worldAsset(current, user?.id));
    })
  );
  app.post(
    "/api/app/profile/world/media",
    route(async (req, res) => {
      const user = await needUser(req);
      if (uploadOwners.size >= 2 || uploadOwners.has(user.id))
        fail(429, "Please wait for the current world upload");
      if (!req.is("multipart/form-data"))
        fail(415, "Send a multipart world media form");
      uploadOwners.add(user.id);
      let directory: string | undefined;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      const disconnected = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once("aborted", disconnected);
      res.once("close", disconnected);
      let cancelParser: (() => void) | undefined;
      try {
        directory = await mkdtemp(path.join(tmpdir(), "respawn-world-"));
        directories.set(req, directory);
        uploadSignals.set(req, controller.signal);
        controller.signal.throwIfAborted();
        try {
          const canceled = new Promise<never>((_resolve, reject) => {
            cancelParser = () => {
              req.unpipe();
              req.resume();
              reject(
                new HttpError(504, "World upload was interrupted or timed out")
              );
            };
            controller.signal.addEventListener("abort", cancelParser, {
              once: true,
            });
          });
          await Promise.race([
            new Promise<void>((resolve, reject) =>
              upload(req, res, error => (error ? reject(error) : resolve()))
            ),
            canceled,
          ]);
        } catch (error) {
          if (error instanceof multer.MulterError)
            fail(
              error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
              "World media form exceeds its limits"
            );
          if (error instanceof HttpError) throw error;
          fail(400, "Invalid world media form");
        }
        if (cancelParser)
          controller.signal.removeEventListener("abort", cancelParser);
        controller.signal.throwIfAborted();
        const slot = uploadFields(req.body);
        if (!req.file) fail(400, "Choose a world media file");
        if (approvedSlots.get(req) !== slot)
          fail(400, "World media slot changed during upload");
        const audio = slot === "music";
        if (
          req.file.size >
          (audio ? WORLD_LIMITS.audioBytes : WORLD_LIMITS.imageBytes)
        )
          fail(413, "Music must be at most 15 MiB; art at most 8 MiB");
        const result = audio
          ? await processWorldAudio(
              req.file.path,
              directory,
              req.file.mimetype,
              controller.signal
            )
          : await sanitizeProfileImage(
              await readFile(req.file.path),
              req.file.mimetype
            );
        controller.signal.throwIfAborted();
        const id = randomUUID();
        const stored = await storagePut(
          `private-media/profile-world/${user.id}/${id}.${audio ? "mp3" : "webp"}`,
          result.data,
          audio ? "audio/mpeg" : "image/webp"
        );
        controller.signal.throwIfAborted();
        const asset: WorldMediaRecord = {
          id,
          ownerId: user.id,
          slot,
          kind: audio ? "audio" : "image",
          objectKey: stored.key,
          bytes: result.data.length,
          ...("duration" in result
            ? { duration: result.duration }
            : { width: result.width, height: result.height }),
          createdAt: new Date().toISOString(),
        };
        await store.create("profile-world-media", user.id, asset);
        // The response must not race the next upload or its scratch-directory inspection.
        await rm(directory, { recursive: true, force: true });
        directory = undefined;
        res.status(201).json(worldAsset(asset, user.id));
      } finally {
        clearTimeout(timeout);
        req.off("aborted", disconnected);
        res.off("close", disconnected);
        if (cancelParser)
          controller.signal.removeEventListener("abort", cancelParser);
        controller.abort();
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
        } finally {
          uploadOwners.delete(user.id);
          directories.delete(req);
          approvedSlots.delete(req);
          uploadSignals.delete(req);
        }
      }
    })
  );
  app.get("/api/media/profile-world/:assetId", route(deliver));
}
