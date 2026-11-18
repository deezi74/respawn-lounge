import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { users, type User } from "../../drizzle/schema";
import type { Source, Clip, Lounge } from "../../shared/app-types";
import { sdk } from "../_core/sdk";
import * as store from "./store";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
const context = new AsyncLocalStorage<{ user?: User | null }>();

export async function optionalUser(req: Request): Promise<User | null> {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.id <= 0) return null;
    const current = context.getStore();
    if (current) current.user = user;
    return user;
  } catch {
    const current = context.getStore();
    if (current) current.user = null;
    return null;
  }
}
export async function needUser(req: Request): Promise<User> {
  const user = await optionalUser(req);
  if (!user) fail(401, "Please sign in");
  return user;
}
export async function loungeMember(
  loungeId: string | undefined,
  userId?: number
): Promise<boolean> {
  if (!loungeId || !userId) return false;
  const lounge = await store.get<Lounge>("lounge", loungeId);
  return (
    !!lounge && (lounge.ownerId === userId || lounge.members.includes(userId))
  );
}
export async function canReadSource(
  source: Source,
  userId?: number
): Promise<boolean> {
  if ((source as Source & { deletedAt?: string }).deletedAt) return false;
  return (
    source.audience === "public" ||
    source.creatorId === userId ||
    (await loungeMember(source.loungeId, userId))
  );
}
export async function canClipSource(
  source: Source,
  userId: number
): Promise<boolean> {
  if (!userId || !(await canReadSource(source, userId))) return false;
  if (source.creatorId === userId) return true;
  if (source.allowClip === "creator") return false;
  if (source.allowClip === "members" && source.audience === "lounge")
    return loungeMember(source.loungeId, userId);
  return true; // Public “members” means signed-in Respawn members, not anonymous viewers.
}
export async function canReadClip(
  clip: Clip,
  userId?: number
): Promise<boolean> {
  if ((clip as Clip & { deletedAt?: string }).deletedAt) return false;
  const source = await store.get<Source>("source", clip.sourceId);
  if (!source || !(await canReadSource(source, userId))) return false;
  if (
    clip.audience === "lounge" &&
    !(await loungeMember(clip.loungeId, userId)) &&
    source.creatorId !== userId
  )
    return false;
  return clip.ownerId === userId || clip.published;
}

function secret() {
  const value = process.env.MANUS_JWT_SECRET;
  if (!value) fail(503, "Media authorization is unavailable");
  return value;
}
function signature(body: string) {
  return createHmac("sha256", secret())
    .update("respawn-media-v1:" + body)
    .digest("base64url");
}
export function mediaTicket(resource: string, userId: number): string {
  const body = Buffer.from(
    JSON.stringify({
      resource,
      userId,
      exp: Date.now() + 5 * 60_000,
      project: process.env.MANUS_PROJECT_ID,
    })
  ).toString("base64url");
  return body + "." + signature(body);
}
/** Tickets contain only a user ID and exact application resource; they never contain storage addresses. */
export async function ticketUser(
  req: Request,
  resource: string
): Promise<User | null> {
  const token = typeof req.query.ticket === "string" ? req.query.ticket : "";
  if (!token || token.length > 2048) return null;
  try {
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra) return null;
    const expected = Buffer.from(signature(body));
    const supplied = Buffer.from(mac);
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return null;
    const value = JSON.parse(Buffer.from(body, "base64url").toString());
    if (
      value.resource !== resource ||
      !Number.isInteger(value.userId) ||
      value.exp <= Date.now() ||
      value.exp > Date.now() + 5 * 60_000 ||
      value.project !== process.env.MANUS_PROJECT_ID
    )
      return null;
    const [user] = await store
      .database()
      .select()
      .from(users)
      .where(eq(users.id, value.userId))
      .limit(1);
    return user ?? null;
  } catch {
    return null;
  }
}
function mediaUrl(resource: string): string {
  const user = context.getStore()?.user;
  const base = `/api/media/${resource}`;
  return user && process.env.MANUS_JWT_SECRET
    ? `${base}?ticket=${encodeURIComponent(mediaTicket(resource, user.id))}`
    : base;
}
export function publicSource(source: Source): Source {
  return {
    id: source.id,
    creatorId: source.creatorId,
    creatorName: source.creatorName,
    title: source.title,
    game: source.game,
    kind: source.kind,
    audience: source.audience,
    loungeId: source.loungeId,
    allowClip: source.allowClip,
    allowPublish: source.allowPublish,
    allowDownload: source.allowDownload,
    duration: source.duration,
    status: source.status,
    createdAt: source.createdAt,
    error: source.error,
    transcript: source.transcript ?? [],
    transcriptionStatus: source.transcriptionStatus,
    posterUrl: (source as Source & { posterKey?: string }).posterKey
      ? mediaUrl(`poster/source/${source.id}`)
      : undefined,
    playbackUrl:
      source.status === "ready" || source.status === "live"
        ? mediaUrl(`source/${source.id}`)
        : undefined,
  };
}
export function publicClip(clip: Clip): Clip {
  return {
    id: clip.id,
    ownerId: clip.ownerId,
    ownerName: clip.ownerName,
    sourceId: clip.sourceId,
    creatorId: clip.creatorId,
    creatorName: clip.creatorName,
    title: clip.title,
    game: clip.game,
    start: clip.start,
    end: clip.end,
    crop: clip.crop,
    cropX: clip.cropX,
    cropY: clip.cropY,
    captions: clip.captions,
    overlay: clip.overlay,
    audience: clip.audience,
    loungeId: clip.loungeId,
    status: clip.status,
    error: clip.error,
    published: clip.published,
    destination: clip.destination,
    createdAt: clip.createdAt,
    footageNote: clip.footageNote,
    playbackUrl:
      clip.status === "ready" ? mediaUrl(`clip/${clip.id}`) : undefined,
    posterUrl: (clip as Clip & { posterKey?: string }).posterKey
      ? mediaUrl(`poster/clip/${clip.id}`)
      : undefined,
  };
}

/** Browser writes must originate on this application. Cross-site Preview embedding does not change fetch Origin. */
export function assertSameOrigin(req: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.get("sec-fetch-site") === "cross-site")
    fail(403, "Cross-site changes are not allowed");
  const origin = req.get("origin");
  if (!origin) {
    if (req.get("sec-fetch-site") !== "same-origin")
      fail(403, "Same-origin request required");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    fail(403, "Invalid request origin");
  }
  const hosts = [
    req.get("host"),
    req.get("x-forwarded-host")?.split(",")[0].trim(),
  ];
  const configured = [
    process.env.MANUS_ADDON_PREVIEW_PUBLIC_ORIGIN,
    process.env.MANUS_ADDON_RUNTIME_PUBLIC_ORIGIN,
    process.env.RESPAWN_PUBLIC_ORIGIN,
  ];
  for (const value of configured) {
    if (value) {
      try {
        hosts.push(new URL(value).host);
      } catch {
        /* malformed configuration never permits a host */
      }
    }
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !hosts.includes(parsed.host)
  )
    fail(403, "Same-origin request required");
}
export function route(
  fn: (
    req: Request,
    res: Response,
    next: NextFunction
  ) => unknown | Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    context.run({}, () => {
      Promise.resolve()
        .then(() => {
          assertSameOrigin(req);
          return fn(req, res, next);
        })
        .catch(error => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          const status =
            error instanceof HttpError
              ? error.status
              : Number(error?.status) ||
                (error?.code === "LIMIT_FILE_SIZE" ? 413 : 500);
          if (status >= 500)
            console.error("[Respawn] request failed", error?.name ?? "Error");
          res
            .status(status)
            .json({
              error:
                status >= 500 && !(error instanceof HttpError)
                  ? "The service could not complete this request"
                  : String(error?.message ?? "Request failed"),
            });
        });
    });
  };
}
