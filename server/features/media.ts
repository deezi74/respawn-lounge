import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Express, type Request, type Response } from "express";
import multer from "multer";
import type { User } from "../../drizzle/schema";
import type {
  Caption,
  ChatMessage,
  Clip,
  Lounge,
  ServiceState,
  Source,
} from "../../shared/app-types";
import { storageGetSignedUrl } from "../storage";
import {
  HttpError,
  canClipSource,
  canReadClip,
  canReadSource,
  fail,
  loungeMember,
  mediaTicket,
  needUser,
  optionalUser,
  publicClip,
  publicSource,
  route,
  ticketUser,
} from "./access";
import {
  enqueueJob,
  MAX_SOURCE_DURATION,
  processingAvailable,
  probeFile,
  putFile,
  startMediaWorker,
  transcription,
  UPLOAD_LIMIT,
  type ClipRecord,
  type SourceRecord,
} from "./processing";
import * as store from "./store";

const RANGE_LIMIT = 8 * 1024 * 1024;
const uploadUsers = new WeakMap<Request, User>();
const uploadDirectories = new WeakMap<Request, string>();
const approvedAudience = new WeakMap<Request, string>();
let uploadsInFlight = 0;
const uploadOwners = new Set<number>();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "A JSON object is required");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 160): string {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    fail(400, `${label} must be text of at most ${max} characters`);
  return value.trim();
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(400, `${label} must be a finite number`);
  return value;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(400, "Permission flags must be true or false");
}
function known(body: Record<string, unknown>, fields: string[]) {
  if (Object.keys(body).some(key => !fields.includes(key)))
    fail(400, "Unsupported field in request");
}
function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
function name(user: User) {
  return user.name?.trim() || "Member";
}

async function sourceFields(
  body: Record<string, unknown>,
  user: User,
  current?: SourceRecord
) {
  const audience = body.audience ?? current?.audience ?? "public";
  if (audience !== "public" && audience !== "lounge")
    fail(400, "Choose public or Lounge audience");
  const loungeId =
    audience === "lounge"
      ? text(body.loungeId ?? current?.loungeId ?? "", "Lounge", 191)
      : undefined;
  if (audience === "lounge" && !(await loungeMember(loungeId, user.id)))
    fail(403, "Join this Lounge before uploading or moving a source into it");
  const allowClip = body.allowClip ?? current?.allowClip ?? "everyone";
  if (!["everyone", "members", "creator"].includes(String(allowClip)))
    fail(400, "Invalid clipping permission");
  const title = text(body.title ?? current?.title ?? "Untitled video", "Title");
  if (!title) fail(400, "A title is required");
  return {
    title,
    game: text(body.game ?? current?.game ?? "", "Game", 80),
    audience,
    loungeId,
    allowClip: allowClip as Source["allowClip"],
    allowPublish: boolean(body.allowPublish, current?.allowPublish ?? true),
    allowDownload: boolean(body.allowDownload, current?.allowDownload ?? true),
  } as Pick<
    Source,
    | "title"
    | "game"
    | "audience"
    | "loungeId"
    | "allowClip"
    | "allowPublish"
    | "allowDownload"
  >;
}
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, done) => done(null, uploadDirectories.get(req)!),
    filename: (_req, _file, done) => done(null, randomUUID() + ".media"),
  }),
  limits: {
    fileSize: UPLOAD_LIMIT,
    files: 1,
    fields: 12,
    parts: 14,
    fieldSize: 16_384,
  },
  fileFilter(req, file, done) {
    if (
      !/^(video\/(mp4|webm|quicktime|x-matroska|mpeg|x-msvideo)|application\/octet-stream)$/.test(
        file.mimetype
      )
    ) {
      done(new HttpError(415, "Upload an MP4, WebM, MOV, MKV or AVI video"));
      return;
    }
    const user = uploadUsers.get(req);
    if (!user) {
      done(new HttpError(401, "Please sign in"));
      return;
    }
    const body = { ...req.query, ...req.body } as Record<string, unknown>;
    // Multer parses fields in wire order: require ACL context before accepting file bytes.
    if (body.audience === undefined) {
      done(
        new HttpError(
          400,
          "Send audience and loungeId before the file, or in the upload query"
        )
      );
      return;
    }
    void sourceFields(body, user).then(
      fields => {
        approvedAudience.set(
          req,
          `${fields.audience}:${fields.loungeId ?? ""}`
        );
        done(null, true);
      },
      error => done(error)
    );
  },
}).single("file");
async function parseVideo(req: Request, res: Response) {
  await new Promise<void>((resolve, reject) =>
    videoUpload(req, res, error => (error ? reject(error) : resolve()))
  );
}
export function clipInterval(
  position: number,
  duration: 15 | 30 | 60,
  availableDuration?: number
) {
  if (
    !Number.isFinite(position) ||
    position < 0 ||
    position > 86_400 ||
    ![15, 30, 60].includes(duration)
  )
    fail(400, "Invalid source position or clip duration");
  const end =
    availableDuration === undefined
      ? position
      : Math.min(position, availableDuration);
  if (end <= 0) fail(422, "There is no viewed footage to clip yet");
  return { start: Math.max(0, end - duration), end };
}
export async function createClip(user: User, input: unknown): Promise<Clip> {
  const body = object(input);
  known(body, ["sourceId", "position", "duration"]);
  const sourceId = text(body.sourceId, "Source", 191);
  const source = await store.get<SourceRecord>("source", sourceId);
  if (!source || !(await canReadSource(source, user.id)))
    fail(404, "Source not found");
  if (!(await canClipSource(source, user.id)))
    fail(403, "The creator does not allow you to clip this source");
  if (!["ready", "live", "offline"].includes(source.status))
    fail(409, "Source footage is still processing");
  const duration = finite(body.duration ?? 30, "Duration") as 15 | 30 | 60;
  const interval = clipInterval(
    finite(body.position, "Player position"),
    duration,
    source.status === "ready" ? source.duration : undefined
  );
  const mappingVerified =
    source.kind !== "live" ||
    source.status === "ready" ||
    source.sourceTimeVerified === true;
  const ready =
    source.status === "ready" &&
    (!!source.objectKey || source.kind === "replay");
  const clip: ClipRecord = {
    id: randomUUID(),
    ownerId: user.id,
    ownerName: name(user),
    sourceId: source.id,
    creatorId: source.creatorId,
    creatorName: source.creatorName,
    title: `${source.title} · clip`,
    game: source.game,
    ...interval,
    crop: "original",
    cropX: 0.5,
    cropY: 0.5,
    captions: [],
    overlay: "",
    audience: source.audience,
    loungeId: source.loungeId,
    published: false,
    status: ready ? "queued" : "bookmarked",
    createdAt: new Date().toISOString(),
    renderVersion: 1,
    sourceRecordingId: source.recordingId,
    viewedPosition: body.position as number,
    mappingVerified,
    footageNote: ready
      ? undefined
      : mappingVerified
        ? "Moment bookmarked. Waiting for this broadcast's recording to become ready."
        : "Moment bookmarked. Live player time is not verified against the recording; select its replay range when footage is ready.",
  };
  await store.create("clip", user.id, clip);
  if (ready) {
    try {
      await enqueueJob("clip", clip.id, user.id, clip.renderVersion);
    } catch (error) {
      await store.mutate<ClipRecord>("clip", clip.id, current => ({
        ...current,
        status: "error",
        error:
          error instanceof HttpError
            ? error.message
            : "Unable to queue processing",
      }));
      throw error;
    }
  }
  return publicClip(clip);
}
function validCaptions(input: unknown, duration: number): Caption[] {
  if (!Array.isArray(input) || input.length > 200)
    fail(400, "Use at most 200 timed captions");
  return (
    input
      .map(value => {
        const item = object(value);
        known(item, ["start", "end", "text"]);
        const start = finite(item.start, "Caption start");
        const end = finite(item.end, "Caption end");
        if (end <= start) fail(400, "Caption end must follow caption start");
        return { start, end, text: text(item.text, "Caption", 300) };
      })
      // Validate original intervals before discarding valid captions outside a trimmed clip.
      .filter(item => item.text && item.end > 0 && item.start < duration)
      .map(item => ({
        ...item,
        start: clamp(item.start, 0, duration),
        end: clamp(item.end, 0, duration),
      }))
      .sort((a, b) => a.start - b.start)
  );
}
function clipResponse(clip: ClipRecord) {
  return {
    ...publicClip(clip),
    transcriptionStatus: clip.transcriptionStatus,
    transcriptionError: clip.transcriptionError,
  };
}
/** Paid speech is only requested explicitly; Sidekick must never call this implicitly. */
export async function transcribeClip(user: User, id: string, input: unknown) {
  const body = object(input);
  known(body, ["confirmed"]);
  if (body.confirmed !== true)
    fail(400, "Confirm speech-service usage and costs before transcribing");
  const existing = await store.get<ClipRecord>("clip", id);
  if (!existing || existing.deletedAt) fail(404, "Clip not found");
  if (existing.ownerId !== user.id)
    fail(403, "Only the clip owner can request paid transcription");
  const source = await store.get<SourceRecord>("source", existing.sourceId);
  if (!source || !(await canReadSource(source, user.id)))
    fail(403, "Original source access was removed");
  if (!(await canClipSource(source, user.id)))
    fail(403, "The creator no longer allows this clip to be rendered");
  if (
    ["queued", "processing", "ready"].includes(
      existing.transcriptionStatus ?? ""
    )
  )
    return clipResponse(existing);
  if (existing.status !== "ready" || !existing.outputKey)
    fail(409, "Wait for a rendered clip before transcribing");
  if (
    !Number.isFinite(existing.end - existing.start) ||
    existing.end - existing.start <= 0 ||
    existing.end - existing.start > 60
  )
    fail(422, "Transcription is limited to clips of at most 60 seconds");
  if (!process.env.MANUS_API_URL || !process.env.MANUS_API_KEY)
    fail(503, "Transcription is unavailable");
  const version = (existing.transcriptionVersion ?? 0) + 1;
  const clip = await store.mutate<ClipRecord>("clip", id, current => {
    if (current.ownerId !== user.id || current.deletedAt)
      fail(403, "Clip cannot be transcribed");
    if (
      current.renderVersion !== existing.renderVersion ||
      current.status !== "ready" ||
      ["queued", "processing", "ready"].includes(
        current.transcriptionStatus ?? ""
      )
    )
      fail(409, "Clip changed. Reload before transcribing");
    return {
      ...current,
      transcriptionStatus: "queued",
      transcriptionVersion: version,
      transcriptionRenderVersion: current.renderVersion,
      transcriptionRequestStarted: false,
      transcriptionError: undefined,
    };
  });
  try {
    await enqueueJob("clip-transcribe", id, user.id, version);
  } catch (error) {
    await store.mutate<ClipRecord>("clip", id, current =>
      current.transcriptionVersion === version &&
      current.transcriptionStatus === "queued"
        ? {
            ...current,
            transcriptionStatus: "error",
            transcriptionError:
              error instanceof HttpError
                ? error.message
                : "Unable to queue transcription",
          }
        : current
    );
    throw error;
  }
  return clipResponse(clip);
}
export async function updateClip(
  user: User,
  id: string,
  input: unknown
): Promise<Clip> {
  const body = object(input);
  known(body, [
    "title",
    "start",
    "end",
    "crop",
    "cropX",
    "cropY",
    "captions",
    "overlay",
  ]);
  const existing = await store.get<ClipRecord>("clip", id);
  if (!existing || existing.deletedAt) fail(404, "Clip not found");
  if (existing.ownerId !== user.id)
    fail(403, "Only the clip owner can edit it");
  if (["queued", "processing"].includes(existing.transcriptionStatus ?? ""))
    fail(409, "Wait for transcription before editing this clip");
  const source = await store.get<SourceRecord>("source", existing.sourceId);
  if (
    !source ||
    !(await canReadSource(source, user.id)) ||
    !(await canClipSource(source, user.id))
  )
    fail(403, "Original source access or clipping permission was removed");
  const available = source.status === "ready" ? source.duration : existing.end;
  const start = clamp(
    body.start === undefined ? existing.start : finite(body.start, "Start"),
    0,
    available
  );
  const end = clamp(
    body.end === undefined ? existing.end : finite(body.end, "End"),
    0,
    available
  );
  if (end - start < 0.1 || end - start > 60)
    fail(400, "Choose an available range from 0.1 to 60 seconds");
  const crop = body.crop ?? existing.crop;
  if (!["original", "vertical", "square"].includes(String(crop)))
    fail(400, "Invalid crop");
  const title =
    body.title === undefined ? existing.title : text(body.title, "Title");
  if (!title) fail(400, "A title is required");
  const captionInput =
    body.captions ??
    existing.captions.map(item => ({
      ...item,
      start: item.start + existing.start - start,
      end: item.end + existing.start - start,
    }));
  const captions = validCaptions(captionInput, end - start);
  const overlay =
    body.overlay === undefined
      ? existing.overlay
      : text(body.overlay, "Emoji overlay", 48);
  if ([...overlay].length > 24)
    fail(400, "Use a short emoji overlay (at most 24 characters)");
  const mappingVerified =
    existing.mappingVerified !== false ||
    (source.status === "ready" &&
      body.start !== undefined &&
      body.end !== undefined);
  const ready = source.status === "ready" && mappingVerified;
  const changes = {
    title,
    start,
    end,
    crop: crop as Clip["crop"],
    cropX: clamp(
      body.cropX === undefined ? existing.cropX : finite(body.cropX, "Crop X"),
      0,
      1
    ),
    cropY: clamp(
      body.cropY === undefined ? existing.cropY : finite(body.cropY, "Crop Y"),
      0,
      1
    ),
    captions,
    overlay,
    mappingVerified,
    status: ready ? ("queued" as const) : ("bookmarked" as const),
  };
  const clip = await store.mutate<ClipRecord>("clip", id, current => {
    if (current.ownerId !== user.id || current.deletedAt)
      fail(403, "Clip cannot be edited");
    if (current.renderVersion !== existing.renderVersion)
      fail(409, "Clip changed in another editor. Reload before editing");
    if (["queued", "processing"].includes(current.transcriptionStatus ?? ""))
      fail(409, "Wait for transcription before editing this clip");
    return {
      ...current,
      ...changes,
      renderVersion: current.renderVersion + 1,
      published: false,
      destination: undefined,
      outputKey: undefined,
      posterKey: undefined,
      error: undefined,
      transcriptionStatus: undefined,
      transcriptionError: undefined,
      transcriptionRenderVersion: undefined,
      transcriptionRequestStarted: undefined,
    };
  });
  if (ready) {
    try {
      await enqueueJob("clip", clip.id, user.id, clip.renderVersion);
    } catch (error) {
      await store.mutate<ClipRecord>("clip", id, current =>
        current.renderVersion === clip.renderVersion
          ? {
              ...current,
              status: "error",
              error:
                error instanceof HttpError
                  ? error.message
                  : "Unable to queue processing",
            }
          : current
      );
      throw error;
    }
  }
  return publicClip(clip);
}

async function sourceFor(
  req: Request,
  id: string,
  resource: string
): Promise<{ source: SourceRecord; user: User | null }> {
  const user = (await optionalUser(req)) ?? (await ticketUser(req, resource));
  const source = await store.get<SourceRecord>("source", id);
  if (!source || !(await canReadSource(source, user?.id)))
    fail(404, "Source not found");
  return { source, user };
}
async function clipFor(
  req: Request,
  id: string,
  resource: string
): Promise<{ clip: ClipRecord; source: SourceRecord; user: User | null }> {
  const user = (await optionalUser(req)) ?? (await ticketUser(req, resource));
  const clip = await store.get<ClipRecord>("clip", id);
  if (!clip || !(await canReadClip(clip, user?.id)))
    fail(404, "Clip not found");
  const source = await store.get<SourceRecord>("source", clip.sourceId);
  if (!source) fail(404, "Original source not found");
  return { clip, source, user };
}
export function parseRange(value: string | undefined, size: number) {
  let start = 0,
    end = Math.min(size - 1, RANGE_LIMIT - 1);
  if (value) {
    const matched = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!matched || (!matched[1] && !matched[2]))
      fail(416, "Only one byte range is supported");
    if (!matched[1]) {
      const suffix = Number(matched[2]);
      if (!suffix) fail(416, "Invalid byte range");
      start = Math.max(0, size - Math.min(suffix, RANGE_LIMIT));
      end = size - 1;
    } else {
      start = Number(matched[1]);
      end = matched[2] ? Math.min(Number(matched[2]), size - 1) : size - 1;
      end = Math.min(end, start + RANGE_LIMIT - 1);
    }
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    fail(416, "Byte range is outside this file");
  return { start, end, partial: !!value || start !== 0 || end !== size - 1 };
}
async function proxyBytes(
  req: Request,
  res: Response,
  url: string,
  mime: string,
  filename?: string
) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60_000);
  const closed = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", closed);
  try {
    // Presigned GET URLs may not authorize HEAD; a one-byte GET reliably obtains total size.
    const first = await fetch(url, {
      headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
      signal: controller.signal,
    });
    if (!first.ok) fail(502, "Stored media is temporarily unavailable");
    const total = /\/(\d+)$/.exec(
      first.headers.get("content-range") ?? ""
    )?.[1];
    const size = Number(total ?? first.headers.get("content-length"));
    await first.body?.cancel();
    if (!Number.isSafeInteger(size) || size <= 0)
      fail(502, "Stored media size is unavailable");
    let range: ReturnType<typeof parseRange>;
    try {
      range = parseRange(req.get("range"), size);
    } catch (error) {
      res.setHeader("Content-Range", `bytes */${size}`);
      throw error;
    }
    const upstream = await fetch(url, {
      headers: {
        Range: `bytes=${range.start}-${range.end}`,
        "Accept-Encoding": "identity",
      },
      signal: controller.signal,
    });
    if (
      !upstream.ok ||
      !upstream.body ||
      (upstream.status !== 206 && (range.start !== 0 || size > RANGE_LIMIT))
    ) {
      await upstream.body?.cancel();
      fail(502, "Storage did not honor the bounded media range");
    }
    const count = range.end - range.start + 1;
    if (
      upstream.status === 206 &&
      upstream.headers.get("content-range") !==
        `bytes ${range.start}-${range.end}/${size}`
    ) {
      await upstream.body.cancel();
      fail(502, "Storage returned a mismatched media range");
    }
    const deliveredSize = upstream.headers.get("content-length");
    if (deliveredSize && Number(deliveredSize) !== count) {
      await upstream.body.cancel();
      fail(502, "Stored media length did not match the requested range");
    }
    res.status(range.partial ? 206 : 200);
    res.set({
      "Content-Type": mime,
      "Content-Length": String(count),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (range.partial)
      res.setHeader(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${size}`
      );
    if (filename)
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`
      );
    if (req.method === "HEAD") {
      await upstream.body.cancel();
      res.end();
      return;
    }
    let received = 0;
    const bounded = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        done(
          received > count
            ? new Error("Upstream exceeded the media range")
            : null,
          chunk
        );
      },
    });
    await pipeline(Readable.fromWeb(upstream.body as never), bounded, res, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(deadline);
    res.off("close", closed);
    controller.abort();
  }
}
let serviceCache: { until: number; value: ServiceState } | undefined;
export async function serviceState(): Promise<ServiceState> {
  if (serviceCache && serviceCache.until > Date.now())
    return serviceCache.value;
  const configured = !!(process.env.MANUS_API_URL && process.env.MANUS_API_KEY);
  let ai = false;
  if (configured) {
    try {
      const response = await fetch(
        new URL(
          "v1/models",
          process.env.MANUS_API_URL!.replace(/\/+$/, "") + "/"
        ),
        {
          headers: { Authorization: `Bearer ${process.env.MANUS_API_KEY}` },
          signal: AbortSignal.timeout(4000),
        }
      );
      const models = response.ok
        ? ((await response.json()) as { data?: unknown[]; error?: unknown })
        : null;
      ai = !!models?.data?.length && !models.error;
    } catch {
      /* probe failure is reflected, never hidden by fake success */
    }
  }
  const live = !!(
    process.env.RESPAWN_CF_TOKEN && process.env.RESPAWN_CF_ACCOUNT_ID
  );
  const value: ServiceState = {
    ai,
    transcription: configured,
    processing:
      (await processingAvailable()) && !!process.env.DATABASE_URL && configured,
    live,
    liveReason: live
      ? undefined
      : "Live-provider connection is disabled until Cloudflare credentials are configured.",
  };
  serviceCache = { until: Date.now() + 10_000, value };
  return value;
}

export function registerMediaRoutes(app: Express) {
  startMediaWorker();
  app.get(
    "/api/app/services",
    route(async (_req, res) => {
      res.set("Cache-Control", "no-store").json(await serviceState());
    })
  );
  app.get(
    "/api/app/sources",
    route(async (req, res) => {
      const user = await optionalUser(req);
      const sources = await store.list<SourceRecord>("source");
      const accessible: Source[] = [];
      for (const source of sources)
        if (
          (!req.query.loungeId || source.loungeId === req.query.loungeId) &&
          (["ready", "live"].includes(source.status) ||
            source.creatorId === user?.id) &&
          (await canReadSource(source, user?.id))
        )
          accessible.push(publicSource(source));
      res
        .set("Cache-Control", "private, no-store")
        .json(
          accessible.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        );
    })
  );
  app.get(
    "/api/app/sources/:id",
    route(async (req, res) => {
      const { source } = await sourceFor(
        req,
        req.params.id,
        `source/${req.params.id}`
      );
      res.set("Cache-Control", "private, no-store").json(publicSource(source));
    })
  );
  app.post(
    "/api/app/upload",
    route(async (req, res) => {
      const user = await needUser(req);
      if (uploadsInFlight >= 2 || uploadOwners.has(user.id))
        fail(429, "Please wait for the current upload");
      if (
        !(await processingAvailable()) ||
        !process.env.MANUS_API_KEY ||
        !process.env.MANUS_API_URL
      )
        fail(503, "Media processing or durable storage is unavailable");
      uploadsInFlight++;
      uploadOwners.add(user.id);
      let directory: string | undefined;
      try {
        directory = await mkdtemp(path.join(tmpdir(), "respawn-upload-"));
        uploadUsers.set(req, user);
        uploadDirectories.set(req, directory);
        await parseVideo(req, res);
        if (!req.file) fail(400, "Choose a video file");
        const fields = await sourceFields({ ...req.query, ...req.body }, user);
        if (
          approvedAudience.get(req) !==
          `${fields.audience}:${fields.loungeId ?? ""}`
        )
          fail(400, "Audience changed after file transfer began");
        const info = await probeFile(req.file.path);
        if (
          !info.width ||
          !info.height ||
          info.width > 8192 ||
          info.height > 8192 ||
          info.duration > MAX_SOURCE_DURATION
        )
          fail(
            422,
            "Upload a video of at most 30 minutes and dimensions at most 8192 pixels"
          );
        const id = randomUUID();
        const rawKey = await putFile(
          req.file.path,
          `${id}-original`,
          req.file.mimetype
        );
        const source: SourceRecord = {
          id,
          creatorId: user.id,
          creatorName: name(user),
          ...fields,
          kind: "upload",
          status: "processing",
          duration: info.duration,
          transcript: [],
          createdAt: new Date().toISOString(),
          rawKey,
          renderVersion: 1,
        };
        await store.create("source", user.id, source);
        try {
          await enqueueJob("source", id, user.id, 1);
        } catch (error) {
          await store.mutate<SourceRecord>("source", id, current => ({
            ...current,
            status: "error",
            error:
              "Processing queue is full. Please upload again after current jobs finish.",
          }));
          throw error;
        }
        res.status(202).json(publicSource(source));
      } finally {
        uploadsInFlight--;
        uploadOwners.delete(user.id);
        uploadUsers.delete(req);
        uploadDirectories.delete(req);
        approvedAudience.delete(req);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    })
  );
  app.patch(
    "/api/app/sources/:id",
    route(async (req, res) => {
      const user = await needUser(req),
        body = object(req.body);
      known(body, [
        "title",
        "game",
        "audience",
        "loungeId",
        "allowClip",
        "allowPublish",
        "allowDownload",
      ]);
      const source = await store.get<SourceRecord>("source", req.params.id);
      if (!source) fail(404, "Source not found");
      if (source.creatorId !== user.id)
        fail(403, "Only the creator can change this source");
      const fields = await sourceFields(body, user, source);
      const updated = await store.mutate<SourceRecord>(
        "source",
        source.id,
        current => {
          if (current.creatorId !== user.id)
            fail(403, "Creator access required");
          return { ...current, ...fields };
        }
      );
      res.json(publicSource(updated));
    })
  );
  app.get(
    "/api/app/clips",
    route(async (req, res) => {
      const scope = req.query.scope ?? "feed";
      if (scope !== "tray" && scope !== "feed")
        fail(400, "Use tray or feed scope");
      const user =
        scope === "tray" ? await needUser(req) : await optionalUser(req);
      const clips = await store.list<ClipRecord>("clip");
      const accessible: Clip[] = [];
      for (const clip of clips)
        if (
          (scope === "tray"
            ? clip.ownerId === user?.id
            : clip.published && clip.status === "ready") &&
          (!req.query.loungeId || clip.loungeId === req.query.loungeId) &&
          (await canReadClip(clip, user?.id))
        )
          accessible.push(clipResponse(clip));
      res
        .set("Cache-Control", "private, no-store")
        .json(
          accessible.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        );
    })
  );
  app.get(
    "/api/app/clips/:id",
    route(async (req, res) => {
      const { clip } = await clipFor(
        req,
        req.params.id,
        `clip/${req.params.id}`
      );
      res.set("Cache-Control", "private, no-store").json(clipResponse(clip));
    })
  );
  app.post(
    "/api/app/clips",
    route(async (req, res) => {
      res.status(202).json(await createClip(await needUser(req), req.body));
    })
  );
  app.patch(
    "/api/app/clips/:id",
    route(async (req, res) => {
      res
        .status(202)
        .json(await updateClip(await needUser(req), req.params.id, req.body));
    })
  );
  app.post(
    "/api/app/clips/:id/transcribe",
    route(async (req, res) => {
      const clip = await transcribeClip(
        await needUser(req),
        req.params.id,
        req.body
      );
      res
        .status(
          ["queued", "processing"].includes(clip.transcriptionStatus ?? "")
            ? 202
            : 200
        )
        .json(clip);
    })
  );
  app.post(
    "/api/app/clips/:id/publish",
    route(async (req, res) => {
      const user = await needUser(req),
        body = object(req.body);
      known(body, ["destination", "loungeId", "confirmed"]);
      if (body.confirmed !== true) fail(400, "Confirm publication first");
      if (body.destination !== "profile" && body.destination !== "lounge")
        fail(400, "Choose a publication destination");
      const clip = await store.get<ClipRecord>("clip", req.params.id);
      if (!clip || clip.deletedAt) fail(404, "Clip not found");
      if (clip.ownerId !== user.id)
        fail(403, "Only the clip owner can publish");
      const source = await store.get<SourceRecord>("source", clip.sourceId);
      if (
        !source ||
        !(await canReadSource(source, user.id)) ||
        !(await canReadClip(clip, user.id))
      )
        fail(403, "Original access was removed");
      if (!source.allowPublish)
        fail(403, "The creator has disabled publishing clips from this source");
      if (clip.status !== "ready" || !clip.outputKey)
        fail(409, "Wait for the rendered clip before publishing");
      const loungeId =
        body.destination === "lounge"
          ? text(body.loungeId, "Lounge", 191)
          : undefined;
      if (
        body.destination === "lounge" &&
        !(await loungeMember(loungeId, user.id))
      )
        fail(403, "Join the destination Lounge before publishing");
      const restrictedLounge =
        source.audience === "lounge"
          ? source.loungeId
          : clip.audience === "lounge"
            ? clip.loungeId
            : undefined;
      if (
        restrictedLounge &&
        (body.destination !== "lounge" || loungeId !== restrictedLounge)
      )
        fail(
          403,
          "Private-source clips can only be published in their original Lounge"
        );
      const lounge = loungeId
        ? await store.get<Lounge>("lounge", loungeId)
        : undefined;
      const published = await store.mutate<ClipRecord>(
        "clip",
        clip.id,
        current => {
          if (
            current.ownerId !== user.id ||
            current.deletedAt ||
            current.status !== "ready" ||
            current.renderVersion !== clip.renderVersion
          )
            fail(409, "Clip changed. Review it before publishing");
          return {
            ...current,
            published: true,
            destination: body.destination as "profile" | "lounge",
            audience:
              restrictedLounge || lounge?.privacy === "private"
                ? "lounge"
                : current.audience,
            loungeId: loungeId ?? current.loungeId,
          };
        }
      );
      res.json(publicClip(published));
    })
  );
  app.delete(
    "/api/app/clips/:id",
    route(async (req, res) => {
      const user = await needUser(req);
      await store.mutate<ClipRecord>("clip", req.params.id, clip => {
        if (clip.ownerId !== user.id) fail(403, "Only the clip owner can Undo");
        return {
          ...clip,
          deletedAt: new Date().toISOString(),
          published: false,
        };
      });
      res.json({ deleted: true });
    })
  );
  app.post(
    "/api/app/media-ticket",
    route(async (req, res) => {
      const user = await needUser(req),
        body = object(req.body);
      const resource = text(body.resource, "Media resource", 256);
      if (/^(source|poster\/source)\/[^/]+$/.test(resource))
        await sourceFor(req, resource.split("/").at(-1)!, resource);
      else if (/^(clip|poster\/clip|download)\/[^/]+$/.test(resource)) {
        const { source } = await clipFor(
          req,
          resource.split("/").at(-1)!,
          resource
        );
        if (
          resource.startsWith("download/") &&
          !source.allowDownload &&
          source.creatorId !== user.id
        )
          fail(403, "The creator has disabled downloads");
      } else fail(400, "Unsupported media resource");
      res.set("Cache-Control", "no-store").json({
        url: `/api/media/${resource}?ticket=${encodeURIComponent(mediaTicket(resource, user.id))}`,
        expiresIn: 300,
      });
    })
  );
  app.get(
    "/api/media/source/:id",
    route(async (req, res) => {
      const { source } = await sourceFor(
        req,
        req.params.id,
        `source/${req.params.id}`
      );
      if (source.objectKey && source.status === "ready")
        return proxyBytes(
          req,
          res,
          await storageGetSignedUrl(source.objectKey),
          "video/mp4"
        );
      if (source.kind === "live" || source.kind === "replay") {
        const { proxyLivePlayback } = await import("./live");
        return proxyLivePlayback(req, res, source);
      }
      fail(409, "Source playback is not ready");
    })
  );
  app.get(
    "/api/media/clip/:id",
    route(async (req, res) => {
      const { clip } = await clipFor(
        req,
        req.params.id,
        `clip/${req.params.id}`
      );
      if (clip.status !== "ready" || !clip.outputKey)
        fail(409, "Clip rendering is not ready");
      return proxyBytes(
        req,
        res,
        await storageGetSignedUrl(clip.outputKey),
        "video/mp4"
      );
    })
  );
  app.get(
    "/api/media/poster/source/:id",
    route(async (req, res) => {
      const { source } = await sourceFor(
        req,
        req.params.id,
        `poster/source/${req.params.id}`
      );
      if (!source.posterKey) fail(404, "Poster is not ready");
      return proxyBytes(
        req,
        res,
        await storageGetSignedUrl(source.posterKey),
        "image/jpeg"
      );
    })
  );
  app.get(
    "/api/media/poster/clip/:id",
    route(async (req, res) => {
      const { clip } = await clipFor(
        req,
        req.params.id,
        `poster/clip/${req.params.id}`
      );
      if (!clip.posterKey || clip.status !== "ready")
        fail(404, "Poster is not ready");
      return proxyBytes(
        req,
        res,
        await storageGetSignedUrl(clip.posterKey),
        "image/jpeg"
      );
    })
  );
  app.get(
    "/api/media/download/:id",
    route(async (req, res) => {
      const { clip, source, user } = await clipFor(
        req,
        req.params.id,
        `download/${req.params.id}`
      );
      if (!source.allowDownload && source.creatorId !== user?.id)
        fail(403, "The creator has disabled downloads");
      if (!clip.outputKey || clip.status !== "ready")
        fail(409, "Clip rendering is not ready");
      return proxyBytes(
        req,
        res,
        await storageGetSignedUrl(clip.outputKey),
        "video/mp4",
        `respawn-${clip.id}.mp4`
      );
    })
  );
  app.post(
    "/api/app/sources/:id/transcribe",
    route(async (req, res) => {
      const user = await needUser(req);
      const body = object(req.body);
      known(body, ["confirmed"]);
      if (body.confirmed !== true)
        fail(400, "Confirm speech-service usage and costs before transcribing");
      const source = await store.get<SourceRecord>("source", req.params.id);
      if (!source || !(await canReadSource(source, user.id)))
        fail(404, "Source not found");
      if (source.creatorId !== user.id)
        fail(403, "Only the source creator can request paid transcription");
      if (source.status !== "ready") fail(409, "Wait for source processing");
      if (!process.env.MANUS_API_URL || !process.env.MANUS_API_KEY)
        fail(503, "Transcription is unavailable");
      if (
        ["queued", "processing", "ready"].includes(
          source.transcriptionStatus ?? ""
        )
      ) {
        res
          .status(source.transcriptionStatus === "ready" ? 200 : 202)
          .json(publicSource(source));
        return;
      }
      const version = (source.renderVersion ?? 1) + 1;
      const updated = await store.mutate<SourceRecord>(
        "source",
        source.id,
        current => {
          if (
            current.creatorId !== user.id ||
            current.deletedAt ||
            current.status !== "ready"
          )
            fail(409, "Source changed. Reload before transcribing");
          if (
            (current.renderVersion ?? 1) !== (source.renderVersion ?? 1) ||
            ["queued", "processing", "ready"].includes(
              current.transcriptionStatus ?? ""
            )
          )
            fail(409, "Transcription was already requested. Reload the source");
          return {
            ...current,
            transcriptionStatus: "queued",
            renderVersion: version,
          };
        }
      );
      try {
        await enqueueJob("transcribe", source.id, user.id, version);
      } catch (error) {
        await store.mutate<SourceRecord>("source", source.id, current =>
          current.renderVersion === version &&
          current.transcriptionStatus === "queued"
            ? { ...current, transcriptionStatus: "error" }
            : current
        );
        throw error;
      }
      res.status(202).json(publicSource(updated));
    })
  );
  const voiceMultipart = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
      fields: 2,
      fieldSize: 1000,
    },
  }).single("file");
  const rawVoice = express.raw({
    type: ["audio/*", "video/webm", "application/octet-stream"],
    limit: "10mb",
  });
  const voiceActive = new Set<number>();
  app.post(
    "/api/app/voice",
    route(async (req, res) => {
      const user = await needUser(req);
      if (voiceActive.has(user.id) || voiceActive.size >= 2)
        fail(429, "Voice transcription is busy");
      voiceActive.add(user.id);
      let directory: string | undefined;
      try {
        let bytes: Uint8Array, mime: string;
        if (req.is("multipart/form-data")) {
          await new Promise<void>((resolve, reject) =>
            voiceMultipart(req, res, error =>
              error ? reject(error) : resolve()
            )
          );
          if (!req.file) fail(400, "Record an audio message");
          bytes = req.file.buffer;
          mime = req.file.mimetype;
        } else {
          await new Promise<void>((resolve, reject) =>
            rawVoice(req, res, error => (error ? reject(error) : resolve()))
          );
          if (!Buffer.isBuffer(req.body) || !req.body.length)
            fail(400, "Record an audio message");
          bytes = req.body;
          mime = req.get("content-type")?.split(";")[0] ?? "audio/webm";
        }
        if (bytes.byteLength > 10 * 1024 * 1024)
          fail(413, "Voice messages are limited to 10 MiB");
        directory = await mkdtemp(path.join(tmpdir(), "respawn-voice-"));
        const file = path.join(directory, "voice.media");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(file, bytes);
        const info = await probeFile(file);
        if (!info.audio || info.duration > 120)
          fail(422, "Record an audio message of at most two minutes");
        res.json(await transcription(bytes, mime, "voice.webm"));
      } finally {
        voiceActive.delete(user.id);
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    })
  );
  app.get(
    "/api/app/chat",
    route(async (req, res) => {
      const sourceId = text(req.query.sourceId, "Source", 191);
      await sourceFor(req, sourceId, `source/${sourceId}`);
      const messages = (await store.list<ChatMessage>("chat"))
        .filter(message => message.sourceId === sourceId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-100);
      res.set("Cache-Control", "private, no-store").json(messages);
    })
  );
  const chatThrottle = new Map<number, number>();
  app.post(
    "/api/app/chat",
    route(async (req, res) => {
      const user = await needUser(req),
        body = object(req.body);
      known(body, ["sourceId", "text", "position", "confirmed"]);
      if (body.confirmed !== true) fail(400, "Confirm sending this message");
      if ((chatThrottle.get(user.id) ?? 0) > Date.now() - 2000)
        fail(429, "Please wait a moment before sending another message");
      const sourceId = text(body.sourceId, "Source", 191),
        messageText = text(body.text, "Message", 1000);
      if (!messageText) fail(400, "Write a message first");
      const { source } = await sourceFor(req, sourceId, `source/${sourceId}`);
      const position = clamp(
        finite(body.position ?? 0, "Player position"),
        0,
        source.duration > 0 ? source.duration : 86_400
      );
      const message: ChatMessage = {
        id: randomUUID(),
        ownerId: user.id,
        name: name(user),
        sourceId,
        text: messageText,
        position,
        createdAt: new Date().toISOString(),
      };
      chatThrottle.set(user.id, Date.now());
      if (chatThrottle.size > 10_000)
        for (const [id, timestamp] of chatThrottle)
          if (timestamp < Date.now() - 60_000) chatThrottle.delete(id);
      await store.create("chat", user.id, message);
      res.status(201).json(message);
    })
  );
}
