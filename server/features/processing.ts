import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { appRecords } from "../../drizzle/schema";
import type { Caption, Clip, Source } from "../../shared/app-types";
import { storageGetSignedUrl } from "../storage";
import { HttpError, canClipSource, canReadSource } from "./access";
import * as store from "./store";

export const UPLOAD_LIMIT = 100 * 1024 * 1024;
export const OUTPUT_LIMIT = 250 * 1024 * 1024;
export const MAX_SOURCE_DURATION = 1800;
const LEASE_MS = 90_000;
const CONCURRENCY = 2;
const JOB_TIMEOUT_MS = 10 * 60_000;
export type SourceRecord = Source & {
  rawKey?: string;
  objectKey?: string;
  posterKey?: string;
  width?: number;
  height?: number;
  sourceTimeVerified?: boolean;
  deletedAt?: string;
  renderVersion?: number;
};
export type ClipRecord = Clip & {
  outputKey?: string;
  posterKey?: string;
  renderVersion: number;
  deletedAt?: string;
  sourceRecordingId?: string;
  viewedPosition?: number;
  mappingVerified?: boolean;
  transcriptionStatus?: "queued" | "processing" | "ready" | "error";
  transcriptionError?: string;
  transcriptionVersion?: number;
  transcriptionRenderVersion?: number;
  transcriptionRequestStarted?: boolean;
};
export type Job = {
  id: string;
  ownerId: number;
  resourceId: string;
  type: "source" | "clip" | "transcribe" | "clip-transcribe";
  version: number;
  state: "queued" | "running" | "done" | "error";
  attempts: number;
  runAt: number;
  leaseUntil?: number;
  token?: string;
  createdAt: number;
  error?: string;
};
type Slot = { id: string; token?: string; leaseUntil: number };

export function runnableJob(job: Job, now: number): boolean {
  return (
    job.runAt <= now &&
    (job.state === "queued" ||
      (job.state === "running" && (job.leaseUntil ?? 0) < now))
  );
}
export function claimJobState(current: Job, token: string, now: number): Job {
  if (!runnableJob(current, now))
    throw new HttpError(409, "Job already claimed or not ready");
  if (current.attempts >= 3)
    return {
      ...current,
      state: "error",
      token,
      leaseUntil: 0,
      error:
        "Processing stopped after three interrupted attempts. Edit the clip to retry",
    };
  return {
    ...current,
    state: "running",
    attempts: current.attempts + 1,
    token,
    leaseUntil: now + LEASE_MS,
  };
}

/** No shell, bounded stderr, time, output size, protocols, and codec threads. */
export async function command(
  binary: string,
  args: string[],
  signal?: AbortSignal,
  timeout = JOB_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "",
      errors = "",
      settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output);
    };
    child.stdout.on("data", chunk => {
      output = (output + chunk.toString()).slice(-1_000_000);
    });
    child.stderr.on("data", chunk => {
      errors = (errors + chunk.toString()).slice(-16_000);
    });
    child.on("error", error => finish(error));
    child.on("close", code =>
      finish(
        code === 0
          ? undefined
          : new Error(`${binary} failed (${code}): ${errors.slice(-1600)}`)
      )
    );
  });
}
export type Probe = {
  duration: number;
  width: number;
  height: number;
  audio: boolean;
};
export async function probeFile(
  file: string,
  signal?: AbortSignal
): Promise<Probe> {
  const data = JSON.parse(
    await command(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        file,
      ],
      signal,
      20_000
    )
  );
  const video = data.streams?.find(
    (stream: { codec_type: string }) => stream.codec_type === "video"
  );
  const duration = Number(data.format?.duration ?? video?.duration);
  let width = Number(video?.width ?? 0),
    height = Number(video?.height ?? 0);
  const rotation = Number(
    video?.tags?.rotate ??
      video?.side_data_list?.find(
        (item: { rotation?: number }) => item.rotation !== undefined
      )?.rotation ??
      0
  );
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  if (!Number.isFinite(duration) || duration <= 0)
    throw new HttpError(422, "The file has no readable media duration");
  return {
    duration,
    width,
    height,
    audio: !!data.streams?.some(
      (stream: { codec_type: string }) => stream.codec_type === "audio"
    ),
  };
}
export async function putFile(
  file: string,
  prefix: string,
  mime: string,
  signal?: AbortSignal
): Promise<string> {
  const api = process.env.MANUS_API_URL,
    key = process.env.MANUS_API_KEY;
  if (!api || !key)
    throw new HttpError(503, "Durable media storage is not configured");
  const objectKey = `private-media/${prefix}-${randomUUID()}`;
  const endpoint = new URL(
    "v1/storage/presign/put",
    api.replace(/\/+$/, "") + "/"
  );
  endpoint.searchParams.set("path", objectKey);
  const presign = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${key}` },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (!presign.ok)
    throw new Error(`Storage upload authorization failed (${presign.status})`);
  const result = (await presign.json()) as { url?: string; error?: unknown };
  if (result.error || !result.url)
    throw new Error("Storage did not authorize the upload");
  const size = (await stat(file)).size;
  if (size > OUTPUT_LIMIT)
    throw new HttpError(413, "Processed media exceeds the size limit");
  const uploaded = await fetch(result.url, {
    method: "PUT",
    headers: { "Content-Type": mime, "Content-Length": String(size) },
    body: createReadStream(file),
    duplex: "half",
    signal: signal ?? AbortSignal.timeout(120_000),
  } as unknown as RequestInit & { duplex: string });
  if (!uploaded.ok)
    throw new Error(`Durable media upload failed (${uploaded.status})`);
  return objectKey;
}
export async function downloadFile(
  url: string,
  file: string,
  signal: AbortSignal,
  limit = OUTPUT_LIMIT
): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body)
    throw new Error(`Media retrieval failed (${response.status})`);
  const length = Number(response.headers.get("content-length"));
  if (length > limit)
    throw new HttpError(413, "Source media exceeds processing limits");
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      done(
        received > limit
          ? new HttpError(413, "Source media exceeds processing limits")
          : null,
        chunk
      );
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    limiter,
    createWriteStream(file),
    { signal }
  );
}
function assTime(value: number) {
  const centiseconds = Math.max(0, Math.round(value * 100));
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, "0")}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, "0")}.${String(centiseconds % 100).padStart(2, "0")}`;
}
function assText(value: string) {
  return value
    .replace(/\\/g, "＼")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, "\\N")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
export function captionFile(
  clip: Pick<Clip, "captions" | "overlay" | "start" | "end">,
  width: number,
  height: number
): string {
  const duration = clip.end - clip.start;
  const size = Math.max(20, Math.round(width / 22));
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Noto Sans,${size},&H00FFFFFF,&H000000FF,&H00151515,&H90000000,0,0,0,0,100,100,0,0,1,2,1,2,24,24,${Math.round(height * 0.08)},1\nStyle: Overlay,Noto Sans,${Math.round(size * 1.8)},&H00FFFFFF,&H000000FF,&H00151515,&H90000000,0,0,0,0,100,100,0,0,1,2,1,8,24,24,${Math.round(height * 0.08)},1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const lines = clip.captions
    .filter(item => item.start < duration && item.end > 0 && item.text.trim())
    .map(
      item =>
        `Dialogue: 0,${assTime(Math.max(0, item.start))},${assTime(Math.min(duration, item.end))},Caption,,0,0,0,,${assText(item.text)}`
    );
  if (clip.overlay)
    lines.push(
      `Dialogue: 1,0:00:00.00,${assTime(duration)},Overlay,,0,0,0,,${assText(clip.overlay)}`
    );
  return head + lines.join("\n") + "\n";
}
const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
export async function renderClipFile(
  input: string,
  clip: ClipRecord,
  directory: string,
  signal?: AbortSignal
) {
  const info = await probeFile(input, signal);
  if (
    !info.width ||
    !info.height ||
    clip.end > info.duration + 0.2 ||
    clip.start < 0 ||
    clip.end <= clip.start ||
    clip.end - clip.start > 60.001
  )
    throw new HttpError(
      422,
      "The selected clip range is not available in this recording"
    );
  let width = even(info.width),
    height = even(info.height);
  const filters: string[] = [];
  if (clip.crop !== "original") {
    const ratio = clip.crop === "vertical" ? 9 / 16 : 1;
    const cropWidth = even(Math.min(width, height * ratio));
    const cropHeight = even(Math.min(height, width / ratio));
    const x = even((width - cropWidth) * clip.cropX) - 2;
    const y = even((height - cropHeight) * clip.cropY) - 2;
    filters.push(
      `crop=${cropWidth}:${cropHeight}:${Math.max(0, x)}:${Math.max(0, y)}`
    );
    [width, height] = clip.crop === "vertical" ? [720, 1280] : [720, 720];
    filters.push(`scale=${width}:${height}:flags=lanczos`);
  } else {
    const scale = Math.min(1, 1280 / width, 720 / height);
    [width, height] = [even(width * scale), even(height * scale)];
    filters.push(`scale=${width}:${height}`);
  }
  if (clip.captions.length || clip.overlay) {
    const captions = path.join(directory, "captions.ass");
    await writeFile(captions, captionFile(clip, width, height));
    // directory is an application-created ASCII scratch path, never user input.
    filters.push(`subtitles=${captions}`);
  }
  filters.push("setsar=1", "fps=30");
  const output = path.join(directory, "clip.mp4");
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
      "file,pipe",
      "-ss",
      String(clip.start),
      "-i",
      input,
      "-t",
      String(clip.end - clip.start),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-maxrate",
      "2500k",
      "-bufsize",
      "5000k",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-fs",
      String(UPLOAD_LIMIT),
      output,
    ],
    signal
  );
  const rendered = await probeFile(output, signal);
  if (Math.abs(rendered.duration - (clip.end - clip.start)) > 0.5)
    throw new Error("Rendered clip duration does not match the selected range");
  const poster = path.join(directory, "poster.jpg");
  await makePoster(output, poster, signal);
  return { output, poster, ...rendered };
}
async function makePoster(input: string, output: string, signal?: AbortSignal) {
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
      "file,pipe",
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:640:force_original_aspect_ratio=decrease",
      "-q:v",
      "3",
      output,
    ],
    signal,
    30_000
  );
}

async function ensureRecord<T extends { id: string }>(kind: string, value: T) {
  if (await store.get(kind, value.id)) return;
  try {
    await store.create(kind, 0, value);
  } catch (error) {
    if (!(await store.get(kind, value.id))) throw error;
  }
}
export async function enqueueJob(
  type: Job["type"],
  resourceId: string,
  ownerId: number,
  version = 1
): Promise<void> {
  await ensureRecord("mediaGate", { id: "media-queue-gate" });
  const id = `job:${type}:${resourceId}:${version}`;
  await store.database().transaction(async tx => {
    await tx
      .select()
      .from(appRecords)
      .where(eq(appRecords.id, "media-queue-gate"))
      .for("update");
    const [existing] = await tx
      .select()
      .from(appRecords)
      .where(eq(appRecords.id, id))
      .limit(1);
    if (existing) return;
    const rows = await tx
      .select({ payload: appRecords.payload })
      .from(appRecords)
      .where(eq(appRecords.kind, "mediaJob"));
    const pending = rows
      .map(row => row.payload as Job)
      .filter(job => ["queued", "running"].includes(job.state));
    if (
      pending.length >= 200 ||
      pending.filter(job => job.ownerId === ownerId).length >= 20
    )
      throw new HttpError(
        429,
        "The processing queue is full. Please wait for your current jobs"
      );
    const now = Date.now();
    const job: Job = {
      id,
      ownerId,
      resourceId,
      type,
      version,
      state: "queued",
      attempts: 0,
      runAt: now,
      createdAt: now,
    };
    await tx
      .insert(appRecords)
      .values({ id, kind: "mediaJob", ownerId, payload: job });
  });
  void tick();
}
export async function transcription(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  signal?: AbortSignal
): Promise<{ text: string; captions: Caption[] }> {
  if (bytes.byteLength > UPLOAD_LIMIT)
    throw new HttpError(413, "Audio exceeds transcription limits");
  const api = process.env.MANUS_API_URL,
    key = process.env.MANUS_API_KEY;
  if (!api || !key) throw new HttpError(503, "Transcription is not configured");
  const body = new FormData();
  body.append("model", "scribe_v2");
  body.append("response_format", "verbose_json");
  body.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: mime }),
    filename
  );
  const response = await fetch(
    new URL("v1/audio/transcriptions", api.replace(/\/+$/, "") + "/"),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal: signal ?? AbortSignal.timeout(120_000),
    }
  );
  if (!response.ok)
    throw new HttpError(
      response.status === 400 ? 422 : response.status === 413 ? 413 : 503,
      response.status === 400
        ? "This audio could not be decoded"
        : "Transcription is temporarily unavailable"
    );
  const value = (await response.json()) as {
    text?: string;
    segments?: { start: number; end: number; text: string }[];
    error?: unknown;
  };
  if (
    value.error ||
    typeof value.text !== "string" ||
    !Array.isArray(value.segments)
  )
    throw new HttpError(503, "Transcription returned an invalid response");
  const captions = value.segments
    .filter(
      item =>
        Number.isFinite(item.start) &&
        Number.isFinite(item.end) &&
        item.start >= 0 &&
        item.end > item.start &&
        typeof item.text === "string"
    )
    .map(item => ({
      start: item.start,
      end: item.end,
      text: item.text.trim().slice(0, 2000),
    }))
    .filter(item => item.text);
  return { text: value.text, captions };
}

/** Extract only the already-rendered cut, never the full creator source. */
export async function extractClipAudioFile(
  input: string,
  directory: string,
  duration: number,
  signal?: AbortSignal
) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60)
    throw new HttpError(
      422,
      "Transcription is limited to clips of at most 60 seconds"
    );
  const info = await probeFile(input, signal);
  if (!info.audio)
    throw new HttpError(
      422,
      "This rendered clip has no audio track to transcribe"
    );
  if (info.duration > 60.25 || Math.abs(info.duration - duration) > 0.5)
    throw new HttpError(
      422,
      "Rendered clip duration does not match its selected range"
    );
  const audio = path.join(directory, "clip-audio.mp3");
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
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      input,
      "-t",
      String(duration),
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      "-fs",
      String(1024 * 1024),
      audio,
    ],
    signal,
    30_000
  );
  const extracted = await probeFile(audio, signal);
  if (
    !extracted.audio ||
    extracted.duration > 60.25 ||
    (await stat(audio)).size > 1024 * 1024
  )
    throw new HttpError(422, "Clip audio exceeds transcription limits");
  return audio;
}

async function runClipTranscription(
  job: Job,
  directory: string,
  signal: AbortSignal
) {
  const resource = await store.get<ClipRecord>("clip", job.resourceId);
  if (
    !resource ||
    resource.deletedAt ||
    resource.transcriptionVersion !== job.version ||
    resource.renderVersion !== resource.transcriptionRenderVersion ||
    !["queued", "processing"].includes(resource.transcriptionStatus ?? "")
  )
    return;
  if (resource.ownerId !== job.ownerId)
    throw new HttpError(403, "Clip ownership changed");
  const authorizedSource = async () => {
    const source = await store.get<SourceRecord>("source", resource.sourceId);
    if (
      !source ||
      !(await canReadSource(source, job.ownerId)) ||
      !(await canClipSource(source, job.ownerId))
    )
      throw new HttpError(
        403,
        "Original source access or clipping permission was removed"
      );
  };
  await authorizedSource();
  if (resource.transcriptionRequestStarted)
    throw new HttpError(
      422,
      "An earlier speech request was interrupted. Confirm transcription again to retry; it will not be charged automatically"
    );
  if (resource.status !== "ready" || !resource.outputKey)
    throw new HttpError(409, "Rendered clip is not ready for transcription");
  await store.mutate<ClipRecord>("clip", resource.id, current =>
    current.transcriptionVersion === job.version && !current.deletedAt
      ? {
          ...current,
          transcriptionStatus: "processing",
          transcriptionError: undefined,
        }
      : current
  );
  const input = path.join(directory, "rendered-clip.mp4");
  await downloadFile(
    await storageGetSignedUrl(resource.outputKey),
    input,
    signal,
    UPLOAD_LIMIT
  );
  const duration = resource.end - resource.start;
  const audio = await extractClipAudioFile(input, directory, duration, signal);
  await authorizedSource();
  // Persist the billing boundary before calling speech. A crash must require renewed consent,
  // not silently repeat an uncertain paid request. Pre-speech retrieval can still retry safely.
  await store.mutate<ClipRecord>("clip", resource.id, current => {
    if (
      current.deletedAt ||
      current.transcriptionVersion !== job.version ||
      current.renderVersion !== resource.renderVersion ||
      current.transcriptionRequestStarted
    )
      throw new HttpError(
        422,
        "Clip changed or a speech request already started"
      );
    return { ...current, transcriptionRequestStarted: true };
  });
  let result: Awaited<ReturnType<typeof transcription>>;
  try {
    result = await transcription(
      new Uint8Array(await readFile(audio)),
      "audio/mpeg",
      "clip.mp3",
      AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    );
  } catch (error) {
    // Even timeouts may have incurred provider usage: never retry the paid boundary automatically.
    throw new HttpError(
      422,
      error instanceof HttpError
        ? error.message
        : "Speech request did not complete. Confirm transcription again to retry"
    );
  }
  signal.throwIfAborted();
  await authorizedSource();
  const updated = await store.mutate<ClipRecord>(
    "clip",
    resource.id,
    current => {
      if (
        current.deletedAt ||
        current.transcriptionVersion !== job.version ||
        current.renderVersion !== resource.renderVersion
      )
        throw new HttpError(422, "Clip changed during transcription");
      return {
        ...current,
        captions: result.captions
          .filter(item => item.start < duration && item.end > 0)
          .map(item => ({
            start: Math.max(0, item.start),
            end: Math.min(duration, item.end),
            text: item.text.slice(0, 300),
          }))
          .filter(item => item.end > item.start)
          .sort((a, b) => a.start - b.start)
          .slice(0, 200),
        transcriptionStatus: "ready",
        transcriptionError: undefined,
        renderVersion: current.renderVersion + 1,
        status: "queued",
        published: false,
        destination: undefined,
        outputKey: undefined,
        posterKey: undefined,
        error: undefined,
      };
    }
  );
  await enqueueJob("clip", updated.id, updated.ownerId, updated.renderVersion);
}

async function inputFor(
  source: SourceRecord,
  file: string,
  signal: AbortSignal
): Promise<SourceRecord> {
  if (source.objectKey) {
    await downloadFile(
      await storageGetSignedUrl(source.objectKey),
      file,
      signal
    );
    return source;
  }
  // Provider URLs are obtained server-side from trusted provider code, never supplied by a user.
  const { getLiveReplay } = await import("./live");
  const replay = await getLiveReplay(source);
  if (!replay)
    throw new HttpError(409, "The broadcast recording is not ready yet");
  await downloadFile(replay.url, file, signal);
  const info = await probeFile(file, signal);
  const objectKey = await putFile(
    file,
    `${source.id}-replay.mp4`,
    "video/mp4",
    signal
  );
  return store.mutate<SourceRecord>("source", source.id, current => ({
    ...current,
    objectKey,
    duration: info.duration,
    width: info.width,
    height: info.height,
    status: "ready",
    kind: "replay",
  }));
}
export async function runMediaJob(job: Job, signal: AbortSignal) {
  const directory = await mkdtemp(path.join(tmpdir(), "respawn-media-"));
  try {
    if (job.type === "clip-transcribe") {
      await runClipTranscription(job, directory, signal);
      return;
    }
    const input = path.join(directory, "input.media");
    if (job.type === "source") {
      const source = await store.get<SourceRecord>("source", job.resourceId);
      if (!source?.rawKey || source.deletedAt) return;
      await store.mutate<SourceRecord>("source", source.id, current => ({
        ...current,
        status: "processing",
        error: undefined,
      }));
      await downloadFile(
        await storageGetSignedUrl(source.rawKey),
        input,
        signal,
        UPLOAD_LIMIT
      );
      const info = await probeFile(input, signal);
      if (
        !info.width ||
        !info.height ||
        info.width > 8192 ||
        info.height > 8192 ||
        info.duration > MAX_SOURCE_DURATION
      )
        throw new HttpError(
          422,
          "Upload must contain a video of at most 30 minutes and dimensions at most 8192 pixels"
        );
      const output = path.join(directory, "source.mp4"),
        poster = path.join(directory, "poster.jpg");
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
          "file,pipe",
          "-i",
          input,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-vf",
          "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "26",
          "-maxrate",
          "1000k",
          "-bufsize",
          "2000k",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-movflags",
          "+faststart",
          "-fs",
          String(OUTPUT_LIMIT),
          output,
        ],
        signal
      );
      const normalized = await probeFile(output, signal);
      if (Math.abs(normalized.duration - info.duration) > 0.6)
        throw new Error(
          "Video could not be normalized within processing limits"
        );
      await makePoster(output, poster, signal);
      const objectKey = await putFile(
        output,
        `${source.id}.mp4`,
        "video/mp4",
        signal
      );
      const posterKey = await putFile(
        poster,
        `${source.id}.jpg`,
        "image/jpeg",
        signal
      );
      signal.throwIfAborted();
      await store.mutate<SourceRecord>("source", source.id, current => ({
        ...current,
        objectKey,
        posterKey,
        duration: normalized.duration,
        width: normalized.width,
        height: normalized.height,
        status: "ready",
        error: undefined,
      }));
      return;
    }
    const resource =
      job.type === "clip"
        ? await store.get<ClipRecord>("clip", job.resourceId)
        : undefined;
    if (
      job.type === "clip" &&
      (!resource ||
        resource.deletedAt ||
        resource.renderVersion !== job.version ||
        resource.mappingVerified === false)
    )
      return;
    const source = await store.get<SourceRecord>(
      "source",
      resource?.sourceId ?? job.resourceId
    );
    if (!source)
      throw new HttpError(404, "Original source is no longer available");
    if (job.type === "transcribe") {
      if (
        source.creatorId !== job.ownerId ||
        source.deletedAt ||
        source.renderVersion !== job.version ||
        !["queued", "processing"].includes(source.transcriptionStatus ?? "")
      )
        return;
      await store.mutate<SourceRecord>("source", source.id, current =>
        current.renderVersion === job.version && !current.deletedAt
          ? { ...current, transcriptionStatus: "processing" }
          : current
      );
    }
    if (resource && !(await canClipSource(source, resource.ownerId)))
      throw new HttpError(403, "The creator no longer allows this clip");
    if (resource)
      await store.mutate<ClipRecord>("clip", resource.id, current =>
        current.renderVersion === job.version && !current.deletedAt
          ? { ...current, status: "processing", error: undefined }
          : current
      );
    await inputFor(source, input, signal);
    if (resource) {
      const rendered = await renderClipFile(input, resource, directory, signal);
      const outputKey = await putFile(
        rendered.output,
        `${resource.id}-v${job.version}.mp4`,
        "video/mp4",
        signal
      );
      const posterKey = await putFile(
        rendered.poster,
        `${resource.id}-v${job.version}.jpg`,
        "image/jpeg",
        signal
      );
      signal.throwIfAborted();
      const currentSource = await store.get<SourceRecord>("source", source.id);
      if (
        !currentSource ||
        !(await canClipSource(currentSource, resource.ownerId))
      )
        throw new HttpError(
          403,
          "Creator permission changed during processing"
        );
      await store.mutate<ClipRecord>("clip", resource.id, current =>
        current.renderVersion === job.version && !current.deletedAt
          ? {
              ...current,
              outputKey,
              posterKey,
              status: "ready",
              error: undefined,
              footageNote: undefined,
            }
          : current
      );
    } else {
      const audio = path.join(directory, "audio.mp3");
      if (!(await probeFile(input, signal)).audio)
        throw new HttpError(
          422,
          "This source has no audio track to transcribe"
        );
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
          "-protocol_whitelist",
          "file,pipe",
          "-i",
          input,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-b:a",
          "64k",
          "-fs",
          String(UPLOAD_LIMIT),
          audio,
        ],
        signal
      );
      const result = await transcription(
        new Uint8Array(await readFile(audio)),
        "audio/mpeg",
        "source.mp3",
        signal
      );
      signal.throwIfAborted();
      await store.mutate<SourceRecord>("source", source.id, current =>
        current.renderVersion === job.version && !current.deletedAt
          ? {
              ...current,
              transcript: result.captions
                .map(item => ({
                  ...item,
                  end: Math.min(item.end, current.duration),
                }))
                .filter(item => item.end > item.start),
              transcriptionStatus: "ready",
            }
          : current
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
let timer: NodeJS.Timeout | undefined;
let ticking = false;
const active = new Map<string, AbortController>();
let lastRecovery = 0;

async function resourceFailure(job: Job, message: string) {
  if (job.type === "clip-transcribe")
    await store
      .mutate<ClipRecord>("clip", job.resourceId, current =>
        current.transcriptionVersion === job.version &&
        !current.deletedAt &&
        ["queued", "processing"].includes(current.transcriptionStatus ?? "")
          ? {
              ...current,
              transcriptionStatus: "error",
              transcriptionError: message,
            }
          : current
      )
      .catch(() => {});
  else if (job.type === "clip")
    await store
      .mutate<ClipRecord>("clip", job.resourceId, current =>
        current.renderVersion === job.version && !current.deletedAt
          ? { ...current, status: "error", error: message }
          : current
      )
      .catch(() => {});
  else
    await store
      .mutate<SourceRecord>("source", job.resourceId, current =>
        job.type === "transcribe"
          ? current.renderVersion === job.version
            ? { ...current, transcriptionStatus: "error" }
            : current
          : { ...current, status: "error", error: message }
      )
      .catch(() => {});
}

async function recover() {
  const sources = await store.list<SourceRecord>("source");
  for (const source of sources) {
    if (source.rawKey && ["uploading", "processing"].includes(source.status))
      await enqueueJob(
        "source",
        source.id,
        source.creatorId,
        source.renderVersion ?? 1
      );
    if (
      source.transcriptionStatus === "queued" ||
      source.transcriptionStatus === "processing"
    )
      await enqueueJob(
        "transcribe",
        source.id,
        source.creatorId,
        source.renderVersion ?? 1
      );
  }
  const clips = await store.list<ClipRecord>("clip");
  for (const clip of clips) {
    if (
      !clip.deletedAt &&
      ["queued", "processing"].includes(clip.transcriptionStatus ?? "")
    )
      await enqueueJob(
        "clip-transcribe",
        clip.id,
        clip.ownerId,
        clip.transcriptionVersion ?? 1
      );
    if (
      !clip.deletedAt &&
      clip.mappingVerified !== false &&
      ["queued", "processing"].includes(clip.status)
    )
      await enqueueJob("clip", clip.id, clip.ownerId, clip.renderVersion);
    if (
      !clip.deletedAt &&
      clip.status === "bookmarked" &&
      clip.mappingVerified === true
    ) {
      const source = sources.find(item => item.id === clip.sourceId);
      if (source && source.recordingId === clip.sourceRecordingId) {
        const { getLiveReplay } = await import("./live");
        const replay = await getLiveReplay(source).catch(() => null);
        if (replay && replay.duration + 0.1 >= clip.end) {
          await store.mutate<ClipRecord>("clip", clip.id, current =>
            current.status === "bookmarked" && !current.deletedAt
              ? { ...current, status: "queued" }
              : current
          );
          await enqueueJob("clip", clip.id, clip.ownerId, clip.renderVersion);
        }
      }
    }
  }
}
async function execute(job: Job, slot: Slot, token: string) {
  const controller = new AbortController();
  active.set(job.id, controller);
  const deadline = setTimeout(
    () => controller.abort(new Error("Processing deadline exceeded")),
    job.type === "clip-transcribe" ? 180_000 : JOB_TIMEOUT_MS
  );
  let extending = false;
  const heartbeat = setInterval(() => {
    if (extending) return;
    extending = true;
    Promise.all([
      store.mutate<Job>("mediaJob", job.id, current => {
        if (current.token !== token || current.state !== "running")
          throw new Error("Job lease lost");
        return { ...current, leaseUntil: Date.now() + LEASE_MS };
      }),
      store.mutate<Slot>("mediaSlot", slot.id, current => {
        if (current.token !== token) throw new Error("Worker lease lost");
        return { ...current, leaseUntil: Date.now() + LEASE_MS };
      }),
    ])
      .catch(() => controller.abort(new Error("Processing lease lost")))
      .finally(() => {
        extending = false;
      });
  }, 20_000);
  try {
    await runMediaJob(job, controller.signal);
    await store.mutate<Job>("mediaJob", job.id, current =>
      current.token === token
        ? { ...current, state: "done", leaseUntil: 0 }
        : current
    );
  } catch (error) {
    const retry =
      !(
        error instanceof HttpError &&
        error.status < 500 &&
        error.status !== 409
      ) && job.attempts < 3;
    const message =
      error instanceof HttpError
        ? error.message
        : "Media processing failed. Retry by editing the clip, or upload the source again";
    const updated = await store
      .mutate<Job>("mediaJob", job.id, current =>
        current.token === token
          ? {
              ...current,
              state: retry ? "queued" : "error",
              runAt: Date.now() + job.attempts * 30_000,
              leaseUntil: 0,
              error: message,
            }
          : current
      )
      .catch(() => undefined);
    if (!retry && updated?.token === token) {
      await resourceFailure(job, message);
    }
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    active.delete(job.id);
    await store
      .mutate<Slot>("mediaSlot", slot.id, current =>
        current.token === token
          ? { ...current, token: undefined, leaseUntil: 0 }
          : current
      )
      .catch(() => {});
    if (timer) void tick();
  }
}
async function tick() {
  if (ticking || active.size >= CONCURRENCY || !timer) return;
  ticking = true;
  try {
    if (Date.now() - lastRecovery > 60_000) {
      lastRecovery = Date.now();
      await recover();
    }
    const jobs = (await store.list<Job>("mediaJob"))
      .filter(job => runnableJob(job, Date.now()))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of jobs) {
      if (active.size >= CONCURRENCY) break;
      const token = randomUUID();
      let claimedSlot: Slot | undefined;
      for (let index = 0; index < CONCURRENCY; index++) {
        const id = `media-worker-slot:${index}`;
        await ensureRecord("mediaSlot", { id, leaseUntil: 0 });
        try {
          claimedSlot = await store.mutate<Slot>("mediaSlot", id, current => {
            if (current.leaseUntil > Date.now())
              throw new HttpError(409, "Worker occupied");
            return { ...current, token, leaseUntil: Date.now() + LEASE_MS };
          });
          break;
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 409))
            throw error;
        }
      }
      if (!claimedSlot) break;
      try {
        const claimed = await store.mutate<Job>("mediaJob", job.id, current =>
          claimJobState(current, token, Date.now())
        );
        if (claimed.state === "error") {
          await resourceFailure(claimed, claimed.error!);
          await store.mutate<Slot>("mediaSlot", claimedSlot.id, current =>
            current.token === token
              ? { ...current, leaseUntil: 0, token: undefined }
              : current
          );
        } else void execute(claimed, claimedSlot, token);
      } catch {
        await store.mutate<Slot>("mediaSlot", claimedSlot.id, current =>
          current.token === token
            ? { ...current, leaseUntil: 0, token: undefined }
            : current
        );
      }
    }
  } catch (error) {
    console.error(
      "[Respawn worker] unable to advance queue",
      error instanceof Error ? error.name : "Error"
    );
  } finally {
    ticking = false;
  }
}
export function startMediaWorker() {
  if (timer) return;
  timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
}
export async function stopMediaWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  for (const controller of active.values())
    controller.abort(new Error("Worker stopping"));
  const until = Date.now() + 10_000;
  while (active.size && Date.now() < until)
    await new Promise(resolve => setTimeout(resolve, 100));
}
export async function processingAvailable(): Promise<boolean> {
  try {
    await command("ffmpeg", ["-version"], undefined, 3000);
    await command("ffprobe", ["-version"], undefined, 3000);
    return true;
  } catch {
    return false;
  }
}
