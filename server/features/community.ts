import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { z } from "zod";
import type { User } from "../../drizzle/schema";
import { defaultPreferences, type Lounge, type Preferences, type Source, type Squad, type StudioSettings } from "../../shared/app-types";
import * as store from "./store";
import { fail, needUser, optionalUser, publicSource, route } from "./access";
import { createLiveInput, liveConfigured, reconcileStudio, registerLiveRoutes } from "./live";

const text = (max: number) => z.string().trim().max(max);
const confirmation = z.object({ confirmed: z.literal(true) });
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) fail(400, result.error.issues.map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; "));
  return result.data;
}
function owner(ownerId: number, user: User) { if (ownerId !== user.id) fail(403, "Only the owner can approve requests"); }
function name(user: User) { return user.name?.trim().slice(0, 100) || "Member"; }
function requestFor(user: User) { return { userId: user.id, name: name(user), createdAt: new Date().toISOString() }; }
function visibleRequests<T extends Lounge | Squad>(value: T, userId?: number): T {
  return { ...value, requests: value.ownerId === userId ? value.requests : value.requests.filter(item => item.userId === userId) };
}

/** All membership changes run synchronously inside store.mutate's row lock. */
export function requestMembership(value: Lounge, user: User): Lounge {
  if (value.ownerId === user.id || value.members.includes(user.id) || value.requests.some(item => item.userId === user.id)) return value;
  if (value.requests.length >= 500) fail(409, "This Lounge has too many pending requests");
  return { ...value, requests: [...value.requests, requestFor(user)] };
}
export function approveMembership(value: Lounge, user: User, userId: number): Lounge {
  owner(value.ownerId, user);
  if (value.members.includes(userId)) return value;
  if (!value.requests.some(item => item.userId === userId)) fail(404, "Membership request not found");
  return { ...value, members: [...value.members, userId], requests: value.requests.filter(item => item.userId !== userId) };
}
export function squadIsOpen(value: Squad, now = Date.now()): boolean {
  return Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > now && value.members.length < value.capacity;
}
function needOpenSquad(value: Squad, now = Date.now()) {
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now) fail(409, "This squad has expired");
  if (value.members.length >= value.capacity) fail(409, "This squad is full");
}
export function requestSquad(value: Squad, user: User, now = Date.now()): Squad {
  // Do not let a stale client join a full or expired listing, even idempotently.
  needOpenSquad(value, now);
  if (value.members.includes(user.id) || value.requests.some(item => item.userId === user.id)) return value;
  if (value.requests.length >= 500) fail(409, "This squad has too many pending requests");
  return { ...value, requests: [...value.requests, requestFor(user)] };
}
export function approveSquad(value: Squad, user: User, userId: number, now = Date.now()): Squad {
  owner(value.ownerId, user);
  needOpenSquad(value, now);
  if (value.members.includes(userId)) return value;
  if (!value.requests.some(item => item.userId === userId)) fail(404, "Join request not found");
  return { ...value, members: [...value.members, userId], requests: value.requests.filter(item => item.userId !== userId) };
}

const loungeInput = z.object({ name: text(100).min(2), description: text(1000).default(""), game: text(100).default(""), privacy: z.enum(["public", "private"]) });
const squadInput = z.object({
  title: text(120).min(2), game: text(100).min(1), platform: text(50).min(1),
  mic: z.enum(["required", "optional", "no-mic"]), startsAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
  capacity: z.number().int().min(2).max(100), vibe: z.enum(["Chill", "Competitive", "Learning"]),
}).superRefine((value, ctx) => {
  const start = Date.parse(value.startsAt), end = Date.parse(value.expiresAt), now = Date.now();
  if (end <= now || end <= start) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must be in the future and after the start" });
  if (end - now > 30 * 24 * 60 * 60_000) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Squad listings can last at most 30 days" });
});
const approveInput = confirmation.extend({ userId: z.number().int().positive() });
const preferenceInput = z.object({
  enabled: z.boolean().optional(), personalization: z.boolean().optional(), clipDuration: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
  name: text(60).min(1).optional(), avatar: text(100).optional(), accent: text(80).optional(),
  tone: z.enum(["Chill", "Hype", "Straight to the Point"]).optional(), games: z.array(text(100).min(1)).max(30).optional(),
  platform: text(50).optional(), mic: z.enum(["required", "optional", "no-mic"]).optional(), availability: text(100).optional(),
}).strict();
export type PreferencesRecord = Preferences & { id: string; ownerId: number };
export type StudioRecord = StudioSettings & { id: string; ownerId: number; provisionState?: "creating"; provisionStartedAt?: string };
export function cleanPreferences(value: Preferences): Preferences {
  // Explicit identity customization is a user-directed setting. The memory toggle
  // is separately required before persisting game/platform/mic/availability data.
  if (!value.personalization) return { ...defaultPreferences, games: [], personalization: false, enabled: value.enabled, clipDuration: value.clipDuration,
    name: value.name, avatar: value.avatar, accent: value.accent, tone: value.tone };
  return { enabled: value.enabled, personalization: true, clipDuration: value.clipDuration, name: value.name, avatar: value.avatar, accent: value.accent, tone: value.tone, games: [...value.games], platform: value.platform, mic: value.mic, availability: value.availability };
}
function preferenceId(userId: number) { return `preferences:${userId}`; }
function studioId(userId: number) { return `studio:${userId}`; }
function missingUnique(error: unknown) { return (error as { code?: string })?.code === "ER_DUP_ENTRY"; }
async function ensurePreferences(user: User): Promise<PreferencesRecord> {
  const id = preferenceId(user.id), existing = await store.get<PreferencesRecord>("preferences", id);
  if (existing) return existing;
  try { return await store.create("preferences", user.id, { ...defaultPreferences, games: [], id, ownerId: user.id }); }
  catch (error) { if (!missingUnique(error)) throw error; return (await store.get<PreferencesRecord>("preferences", id))!; }
}
async function ensureStudio(user: User): Promise<StudioRecord> {
  const id = studioId(user.id), existing = await store.get<StudioRecord>("studio", id);
  if (existing) return existing;
  try { return await store.create<StudioRecord>("studio", user.id, { id, ownerId: user.id, title: "", game: "", connected: false, provider: "Cloudflare Stream" }); }
  catch (error) { if (!missingUnique(error)) throw error; return (await store.get<StudioRecord>("studio", id))!; }
}
function studioResponse(value: StudioRecord): StudioSettings {
  // Never pass provider/store internals or OBS credentials through ordinary reads.
  return { title: value.title, game: value.game, scheduledAt: value.scheduledAt, sourceId: value.sourceId,
    connected: liveConfigured() && value.connected, provider: "Cloudflare Stream", status: liveConfigured() ? value.status || "Not connected" : "Live streaming is not configured; provider connection is deferred" };
}
const studioInput = z.object({ title: text(120).optional(), game: text(100).optional(), scheduledAt: z.string().datetime({ offset: true }).nullable().optional(), sourceId: z.string().max(100).optional() }).strict();

export function registerCommunityRoutes(app: Express) {
  app.get("/api/app/lounges", route(async (req, res) => {
    const user = await optionalUser(req), values = await store.list<Lounge>("lounge");
    res.set("Cache-Control", "private, no-store").json(values.filter(value => value.privacy === "public" || value.ownerId === user?.id || !!user && value.members.includes(user.id)).map(value => visibleRequests(value, user?.id)));
  }));
  app.post("/api/app/lounges", route(async (req, res) => {
    const user = await needUser(req), input = parse(loungeInput, req.body);
    const lounge: Lounge = { ...input, id: randomUUID(), ownerId: user.id, members: [user.id], requests: [], createdAt: new Date().toISOString() };
    res.status(201).json(await store.create("lounge", user.id, lounge));
  }));
  app.post("/api/app/lounges/:id/join", route(async (req, res) => {
    const user = await needUser(req); parse(confirmation, req.body);
    const lounge = await store.mutate<Lounge>("lounge", req.params.id, value => requestMembership(value, user));
    // A known private invite ID can receive a request, but does not reveal its content or membership.
    res.json(lounge.privacy === "private" && !lounge.members.includes(user.id) ? { requested: true, id: lounge.id } : visibleRequests(lounge, user.id));
  }));
  app.post("/api/app/lounges/:id/approve", route(async (req, res) => {
    const user = await needUser(req), input = parse(approveInput, req.body);
    res.json(await store.mutate<Lounge>("lounge", req.params.id, value => approveMembership(value, user, input.userId)));
  }));
  app.get("/api/app/squads", route(async (req, res) => {
    const user = await optionalUser(req), values = await store.list<Squad>("squad"), now = Date.now();
    const equal = (actual: string, query: unknown) => typeof query !== "string" || !query.trim() || actual.toLowerCase() === query.trim().toLowerCase();
    res.set("Cache-Control", "private, no-store").json(values.filter(value => value.ownerId === user?.id || squadIsOpen(value, now) && equal(value.game, req.query.game) && equal(value.platform, req.query.platform) && equal(value.mic, req.query.mic)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).map(value => visibleRequests(value, user?.id)));
  }));
  app.post("/api/app/squads", route(async (req, res) => {
    const user = await needUser(req), input = parse(squadInput, req.body);
    const squad: Squad = { ...input, id: randomUUID(), ownerId: user.id, ownerName: name(user), members: [user.id], requests: [], createdAt: new Date().toISOString() };
    res.status(201).json(await store.create("squad", user.id, squad));
  }));
  app.post("/api/app/squads/:id/join", route(async (req, res) => {
    const user = await needUser(req); parse(confirmation, req.body);
    res.json(visibleRequests(await store.mutate<Squad>("squad", req.params.id, value => requestSquad(value, user)), user.id));
  }));
  app.post("/api/app/squads/:id/approve", route(async (req, res) => {
    const user = await needUser(req), input = parse(approveInput, req.body);
    res.json(await store.mutate<Squad>("squad", req.params.id, value => approveSquad(value, user, input.userId)));
  }));
  app.get("/api/app/settings", route(async (req, res) => {
    const user = await needUser(req), saved = await store.get<PreferencesRecord>("preferences", preferenceId(user.id));
    res.set("Cache-Control", "private, no-store").json(cleanPreferences(saved || defaultPreferences));
  }));
  app.patch("/api/app/settings", route(async (req, res) => {
    const user = await needUser(req), input = parse(preferenceInput, req.body); await ensurePreferences(user);
    const value = await store.mutate<PreferencesRecord>("preferences", preferenceId(user.id), current => {
      if (current.ownerId !== user.id) fail(403, "These are not your preferences");
      return { ...cleanPreferences({ ...current, ...input }), id: current.id, ownerId: user.id };
    });
    res.json(cleanPreferences(value));
  }));
  app.delete("/api/app/settings", route(async (req, res) => {
    const user = await needUser(req); await ensurePreferences(user);
    const value = await store.mutate<PreferencesRecord>("preferences", preferenceId(user.id), current => {
      if (current.ownerId !== user.id) fail(403, "These are not your preferences");
      return { ...defaultPreferences, games: [], enabled: current.enabled, clipDuration: current.clipDuration, id: current.id, ownerId: user.id };
    });
    res.json(cleanPreferences(value));
  }));
  app.get("/api/app/studio", route(async (req, res) => {
    const user = await needUser(req), saved = await store.get<StudioRecord>("studio", studioId(user.id));
    const value = saved ? await reconcileStudio(saved) : { id: studioId(user.id), ownerId: user.id, title: "", game: "", connected: false, provider: "Cloudflare Stream" as const };
    res.set("Cache-Control", "private, no-store").json(studioResponse(value));
  }));
  app.patch("/api/app/studio", route(async (req, res) => {
    const user = await needUser(req), input = parse(studioInput, req.body); await ensureStudio(user);
    if (input.scheduledAt && Date.parse(input.scheduledAt) <= Date.now()) fail(400, "Schedule must be in the future; it does not start a broadcast automatically");
    if (input.sourceId) {
      const source = await store.get<Source>("source", input.sourceId);
      if (!source || source.creatorId !== user.id) fail(403, "Only your own source can be selected in Studio");
      const current = await store.get<StudioRecord>("studio", studioId(user.id));
      if (current?.liveInputId && source.liveInputId !== current.liveInputId) fail(409, "An existing live input must retain its own broadcast source");
    }
    const value = await store.mutate<StudioRecord>("studio", studioId(user.id), current => {
      if (current.ownerId !== user.id) fail(403, "These are not your Studio settings");
      return { ...current, ...input, scheduledAt: input.scheduledAt === null ? undefined : input.scheduledAt ?? current.scheduledAt };
    });
    res.json(studioResponse(value));
  }));
  app.post("/api/app/studio/connect", route(async (req, res) => {
    const user = await needUser(req); parse(confirmation, req.body);
    if (!liveConfigured()) fail(503, "Live streaming is not configured. Provider connection is deferred; no input or broadcast was created.");
    const studio = await ensureStudio(user);
    const result = await createLiveInput(user, studio);
    res.set("Cache-Control", "private, no-store").json({ ...studioResponse(result.studio), rtmpsUrl: result.rtmpsUrl, streamKey: result.streamKey, source: publicSource(result.source) });
  }));
  registerLiveRoutes(app);
}
