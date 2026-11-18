import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import type { User } from "../../drizzle/schema";
import type { Source } from "../../shared/app-types";
import type { StudioRecord } from "./community";
import * as store from "./store";
import { canReadSource, fail, HttpError, loungeMember, optionalUser, route, ticketUser } from "./access";

/** Documentation contracts verified 2026-11-18; see /home/ubuntu/live-research.md.
 * Live input creation provisions OBS ingest only. This module never starts a broadcast.
 */
type Input = { uid: string; status?: string; enabled?: boolean; rtmps?: { url: string; streamKey: string }; recording?: { mode?: string; requireSignedURLs?: boolean } };
type Video = { uid: string; duration?: number; readyToStream?: boolean; status?: { state?: string; errorReasonCode?: string }; playback?: { hls?: string }; requireSignedURLs?: boolean; created?: string };
type LiveSource = Source & { sourceTimeVerified?: boolean; deletedAt?: string };
type Downloads = { default?: { status?: string; url?: string } };
const apiBase = "https://api.cloudflare.com/client/v4";
export function liveConfigured(): boolean {
  return !!process.env.RESPAWN_CF_TOKEN?.trim() && !!process.env.RESPAWN_CF_ACCOUNT_ID?.trim();
}
function config() {
  if (!liveConfigured()) fail(503, "Cloudflare Stream is not configured; live-provider connection is deferred");
  return { token: process.env.RESPAWN_CF_TOKEN!.trim(), account: process.env.RESPAWN_CF_ACCOUNT_ID!.trim() };
}
async function cf<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const { token, account } = config();
  let response: globalThis.Response;
  try {
    response = await fetch(`${apiBase}/accounts/${encodeURIComponent(account)}/stream${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000), redirect: "error",
    });
  } catch { fail(503, "Cloudflare Stream could not be reached. No broadcast was started."); }
  if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 503, response.status === 404 ? "Cloudflare recording or input is not available yet" : "Cloudflare Stream rejected this operation; check the account configuration and Stream token permissions");
  const raw = await response.text();
  if (raw.length > 2_000_000) fail(503, "Cloudflare returned an oversized response");
  let envelope: { success?: boolean; result?: T };
  try { envelope = JSON.parse(raw); } catch { fail(503, "Cloudflare returned an invalid response"); }
  if (envelope.success !== true || envelope.result === undefined || envelope.result === null) fail(503, "Cloudflare Stream could not complete this operation");
  return envelope.result;
}
function pathId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) fail(503, "Stored provider identifier is invalid");
  return encodeURIComponent(id);
}
async function videoFor(source: Source): Promise<Video | null> {
  if (!source.recordingId) return null; // Never substitute a later broadcast or an older ready video.
  try { return await cf<Video>(`/${pathId(source.recordingId)}`); }
  catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
}
function deliveryUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { fail(503, "Cloudflare playback URL is invalid"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !(host === "videodelivery.net" || host.endsWith(".videodelivery.net") || host === "cloudflarestream.com" || host.endsWith(".cloudflarestream.com"))) fail(503, "Provider playback host is not trusted");
  return url;
}
async function signedDelivery(uid: string, original: string, downloadable = false): Promise<string> {
  const url = deliveryUrl(original), parts = url.pathname.split("/");
  if (parts[1] !== uid) fail(503, "Provider playback does not match the pinned recording");
  const grant = await cf<{ token: string }>(`/${pathId(uid)}/token`, "POST", { exp: Math.floor(Date.now() / 1000) + 300, ...(downloadable ? { downloadable: true } : {}) });
  if (typeof grant.token !== "string" || !grant.token || grant.token.length > 16_000) fail(503, "Cloudflare did not issue playback authorization");
  parts[1] = grant.token; url.pathname = parts.join("/");
  return url.toString();
}

/** Server-only. The media worker still enforces clipping consent before downloading.
 * The complete pinned broadcast must be ready, as must its generated MP4 download.
 * A missing/processing recording returns null, never a simulated replay.
 */
export async function getLiveReplay(source: Source): Promise<{ url: string; duration: number } | null> {
  if (!liveConfigured() || !source.recordingId) return null;
  const video = await videoFor(source);
  if (!video || video.status?.state !== "ready" || video.readyToStream !== true || !Number.isFinite(video.duration) || video.duration! <= 0) return null;
  let downloads = await cf<Downloads>(`/${pathId(source.recordingId)}/downloads`);
  if (!downloads.default) {
    // Generation is server-authorized and never broadens signed source visibility.
    downloads = await cf<Downloads>(`/${pathId(source.recordingId)}/downloads`, "POST");
  }
  if (downloads.default?.status !== "ready" || !downloads.default.url) return null;
  return { url: await signedDelivery(source.recordingId, downloads.default.url, true), duration: video.duration! };
}
/** Server-only signed upstream URL; never redirect the browser to this URL. */
export async function getLivePlayback(source: Source): Promise<string | null> {
  if (!liveConfigured() || !source.recordingId) return null;
  const video = await videoFor(source);
  if (!video?.playback?.hls || !(video.status?.state === "live-inprogress" || video.status?.state === "ready" && video.readyToStream === true)) return null;
  const url = new URL(await signedDelivery(source.recordingId, video.playback.hls));
  url.searchParams.set("dvrEnabled", "true");
  return url.toString();
}

export async function createLiveInput(user: User, studio: StudioRecord): Promise<{ studio: StudioRecord; source: Source; rtmpsUrl: string; streamKey: string }> {
  config();
  if (studio.ownerId !== user.id) fail(403, "Only the Studio owner can connect an input");
  if (studio.liveInputId) {
    const input = await cf<Input>(`/live_inputs/${pathId(studio.liveInputId)}`);
    const source = studio.sourceId ? await store.get<Source>("source", studio.sourceId) : undefined;
    if (!source || source.creatorId !== user.id || !input.rtmps?.url || !input.rtmps.streamKey) fail(503, "Existing provider input cannot be safely retrieved; no replacement was created");
    const verified = await store.mutate<StudioRecord>("studio", studio.id, value => ({ ...value, connected: true, status: input.status || "Input provisioned; OBS has not connected" }));
    return { studio: verified, source, rtmpsUrl: input.rtmps.url, streamKey: input.rtmps.streamKey };
  }
  const selected = studio.sourceId ? await store.get<Source>("source", studio.sourceId) : undefined;
  if (selected && selected.creatorId !== user.id) fail(403, "Only your source can configure a live audience");
  if (selected?.audience === "lounge" && !await loungeMember(selected.loungeId, user.id)) fail(403, "Current Lounge membership is required for a private broadcast");
  await store.mutate<StudioRecord>("studio", studio.id, value => {
    if (value.ownerId !== user.id) fail(403, "Only the Studio owner can connect an input");
    if (value.liveInputId || value.provisionState === "creating") fail(409, "Input provisioning is already pending; no duplicate input was created");
    return { ...value, provisionState: "creating", provisionStartedAt: new Date().toISOString(), connected: false, status: "Provisioning input; not broadcasting" };
  });
  let input: Input;
  try {
    input = await cf<Input>("/live_inputs", "POST", { meta: { name: studio.title || `Respawn creator ${user.id}` }, enabled: true, preferLowLatency: false,
      recording: { mode: "automatic", requireSignedURLs: true, hideLiveViewerCount: true, timeoutSeconds: 10 } });
  } catch (error) {
    // An HTTP/timeout failure may be ambiguous. Keep the durable reservation rather than silently creating another paid input.
    await store.mutate<StudioRecord>("studio", studio.id, value => ({ ...value, connected: false, status: "Input provisioning was not verified; check the provider before retrying" })).catch(() => undefined);
    throw error;
  }
  if (!input.uid || !input.rtmps?.url || !input.rtmps.streamKey) fail(503, "Cloudflare did not return complete OBS credentials; input is not marked connected");
  const source: LiveSource = { id: randomUUID(), creatorId: user.id, creatorName: user.name || "Member", title: studio.title || "Untitled broadcast", game: studio.game,
    kind: "live", audience: selected?.audience || "public", loungeId: selected?.loungeId, allowClip: selected?.allowClip || "creator", allowPublish: selected?.allowPublish ?? false,
    allowDownload: selected?.allowDownload ?? false, duration: 0, status: "offline", createdAt: new Date().toISOString(), transcript: [], liveInputId: input.uid, sourceTimeVerified: false };
  await store.create("source", user.id, source);
  const saved = await store.mutate<StudioRecord>("studio", studio.id, value => ({ ...value, liveInputId: input.uid, sourceId: source.id, connected: true,
    provisionState: undefined, rtmpsUrl: input.rtmps!.url, streamKey: input.rtmps!.streamKey, status: "Input provisioned. Configure OBS to broadcast; no broadcast has started." }));
  return { studio: saved, source, rtmpsUrl: input.rtmps.url, streamKey: input.rtmps.streamKey };
}

/** Reconcile actual API state into one immutable-broadcast Source per Video UID. */
export async function reconcileStudio(studio: StudioRecord): Promise<StudioRecord> {
  if (!studio.liveInputId || !liveConfigured()) {
    if (!studio.connected) return { ...studio, connected: false, status: "Live-provider connection is unavailable or deferred" };
    return store.mutate<StudioRecord>("studio", studio.id, current => ({ ...current, connected: false, status: "Live-provider connection is unavailable or deferred" }));
  }
  try {
    const input = await cf<Input>(`/live_inputs/${pathId(studio.liveInputId)}`);
    const videos = await cf<Video[]>(`/live_inputs/${pathId(studio.liveInputId)}/videos`);
    if (!Array.isArray(videos)) fail(503, "Cloudflare returned invalid broadcast status");
    const sources = (await store.list<LiveSource>("source")).filter(value => value.liveInputId === studio.liveInputId && value.creatorId === studio.ownerId && !value.deletedAt);
    for (const source of sources.filter(value => value.recordingId)) {
      const video = videos.find(value => value.uid === source.recordingId) || await videoFor(source);
      if (!video) continue; // Recording transition can be not-found temporarily.
      const state = video.status?.state;
      const status: Source["status"] = state === "live-inprogress" ? "live" : state === "ready" && video.readyToStream === true ? "ready" : state === "error" ? "error" : "processing";
      await store.mutate<LiveSource>("source", source.id, current => ({ ...current, status, kind: status === "ready" ? "replay" : current.kind,
        duration: Number.isFinite(video.duration) && video.duration! >= 0 ? video.duration! : current.duration,
        error: status === "error" ? "Provider recording failed" : undefined }));
    }
    const active = videos.find(video => video.status?.state === "live-inprogress");
    let sourceId = studio.sourceId;
    if (active) {
      let source = sources.find(value => value.recordingId === active.uid);
      if (!source) {
        const provisional = sources.find(value => !value.recordingId);
        if (provisional) source = await store.mutate<LiveSource>("source", provisional.id, current => {
          if (current.recordingId && current.recordingId !== active.uid) fail(409, "Broadcast changed during reconciliation");
          return { ...current, recordingId: active.uid, status: "live" };
        });
        else {
          const previous = sources.find(value => value.id === studio.sourceId) || sources[0];
          if (!previous) fail(503, "The provider input has no owned source configuration");
          // Deterministic provider-derived app ID makes duplicate reconciliation safe without rebinding a past clip.
          const id = `broadcast:${studio.liveInputId}:${active.uid}`;
          const record: LiveSource = { ...previous, id, title: studio.title || previous.title, game: studio.game, kind: "live", status: "live", createdAt: active.created || new Date().toISOString(),
            transcript: [], transcriptionStatus: undefined, duration: 0, recordingId: active.uid, sourceTimeVerified: false };
          // Enumerate only domain fields; old private storage keys are not inherited to a new broadcast.
          const { id: recordId, creatorId, creatorName, title, game, kind, audience, loungeId, allowClip, allowPublish, allowDownload, duration, status, createdAt, transcript, recordingId, liveInputId, sourceTimeVerified } = record;
          try { source = await store.create("source", studio.ownerId, { id: recordId, creatorId, creatorName, title, game, kind, audience, loungeId, allowClip, allowPublish, allowDownload, duration, status, createdAt, transcript, recordingId, liveInputId, sourceTimeVerified }); }
          catch (error) { if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error; source = await store.get<LiveSource>("source", id); }
        }
      }
      sourceId = source?.id || sourceId;
    }
    return await store.mutate<StudioRecord>("studio", studio.id, current => ({ ...current, sourceId, connected: true, status: active ? "Broadcast live (verified by Cloudflare)" : input.status === "connected" ? "Encoder connected; waiting for broadcast video" : "Input provisioned; no live broadcast" }));
  } catch (error) {
    const status = error instanceof HttpError && error.status === 404 ? "Provider input is unavailable" : "Provider status could not be verified";
    return await store.mutate<StudioRecord>("studio", studio.id, current => ({ ...current, connected: false, status }));
  }
}
let reconciliation: Promise<void> | undefined;
let reconciledAt = 0;
/** Finite request-triggered work, not an unattended polling service. */
export async function reconcileLiveSources(): Promise<void> {
  if (!liveConfigured()) return;
  if (!reconciliation && Date.now() - reconciledAt < 15_000) return;
  if (!reconciliation) reconciliation = (async () => {
    const studios = (await store.list<StudioRecord>("studio")).filter(value => value.liveInputId);
    // Bound concurrency and avoid an unbounded provider fan-out.
    for (let index = 0; index < studios.length; index += 3) await Promise.all(studios.slice(index, index + 3).map(reconcileStudio));
    reconciledAt = Date.now();
  })().finally(() => { reconciliation = undefined; });
  await reconciliation;
}

function proxyKey() {
  if (!process.env.MANUS_JWT_SECRET) fail(503, "Live media authorization is unavailable");
  return createHash("sha256").update(`respawn-live-proxy-v1:${process.env.MANUS_JWT_SECRET}`).digest();
}
function encryptResource(sourceId: string, url: string): string {
  deliveryUrl(url);
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", proxyKey(), iv);
  cipher.setAAD(Buffer.from(sourceId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ url, exp: Date.now() + 5 * 60_000 })), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
function decryptResource(sourceId: string, ref: string): string {
  if (!ref || ref.length > 30_000) fail(403, "Invalid live media grant");
  try {
    const data = Buffer.from(ref, "base64url"), decipher = createDecipheriv("aes-256-gcm", proxyKey(), data.subarray(0, 12));
    decipher.setAAD(Buffer.from(sourceId)); decipher.setAuthTag(data.subarray(12, 28));
    const value = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
    if (typeof value.url !== "string" || !Number.isFinite(value.exp) || value.exp <= Date.now() || value.exp > Date.now() + 5 * 60_000) fail(403, "Live media grant expired");
    return deliveryUrl(value.url).toString();
  } catch { fail(403, "Invalid or expired live media grant"); }
}
export function rewriteLiveManifest(manifest: string, upstream: string, sourceId: string, ticket?: string): string {
  if (!manifest.trimStart().startsWith("#EXTM3U") || manifest.length > 1_000_000) fail(503, "Provider returned an invalid HLS manifest");
  const local = (value: string) => {
    const url = deliveryUrl(new URL(value, upstream).toString());
    const query = new URLSearchParams({ ref: encryptResource(sourceId, url.toString()) });
    if (ticket) query.set("ticket", ticket);
    return `/api/live/source/${encodeURIComponent(sourceId)}/resource?${query}`;
  };
  return manifest.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (!line.startsWith("#")) return local(line.trim());
    return line.replace(/URI="([^"]+)"/g, (_, value: string) => `URI="${local(value)}"`);
  }).join("\n");
}
async function mediaUser(req: Request, source: Source) {
  const user = await optionalUser(req) || await ticketUser(req, `source/${source.id}`);
  if (!await canReadSource(source, user?.id)) fail(403, "You do not have access to this live source");
  return user;
}
async function proxyResource(req: Request, res: Response, source: Source, url: string) {
  await mediaUser(req, source); // Recheck membership on every variant/segment/range request.
  deliveryUrl(url);
  const range = req.get("range");
  if (range && !/^bytes=\d+-\d*$/.test(range)) fail(416, "A single valid byte range is required");
  const response = await fetch(url, { headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok && response.status !== 206) fail(response.status === 404 || response.status === 204 ? 409 : 503, "Provider footage is not available yet");
  const type = response.headers.get("content-type") || "application/octet-stream";
  res.set("Cache-Control", "private, no-store").set("X-Content-Type-Options", "nosniff");
  for (const key of ["preview-start-seconds", "stream-media-id"]) { const value = response.headers.get(key); if (value) res.set(key, value); }
  if (/mpegurl/i.test(type) || new URL(url).pathname.endsWith(".m3u8")) {
    const body = await response.text();
    const ticket = typeof req.query.ticket === "string" ? req.query.ticket : undefined;
    res.type("application/vnd.apple.mpegurl").send(rewriteLiveManifest(body, url, source.id, ticket));
    return;
  }
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > 32 * 1024 * 1024) fail(413, "Live media segment is too large");
  res.status(response.status).set("Content-Type", type);
  for (const key of ["content-range", "accept-ranges", "content-length"]) { const value = response.headers.get(key); if (value) res.set(key, value); }
  if (!response.body) { res.end(); return; }
  const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  let bytes = 0;
  stream.on("data", chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 32 * 1024 * 1024) { stream.destroy(); res.destroy(); } });
  stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res);
}
/** Media route integration: this hides Cloudflare tokens and rewrites nested HLS resources. */
export async function proxyLivePlayback(req: Request, res: Response, source: Source): Promise<void> {
  await mediaUser(req, source);
  const upstream = await getLivePlayback(source);
  if (!upstream) fail(409, "This broadcast has no playable pinned footage yet");
  await proxyResource(req, res, source, upstream);
}
export function registerLiveRoutes(app: Express) {
  app.get("/api/live/source/:id/resource", route(async (req, res) => {
    const source = await store.get<Source>("source", req.params.id);
    if (!source) fail(404, "Source not found");
    await mediaUser(req, source);
    const ref = typeof req.query.ref === "string" ? req.query.ref : "";
    await proxyResource(req, res, source, decryptResource(source.id, ref));
  }));
}
