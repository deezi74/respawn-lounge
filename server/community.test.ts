import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import type { Lounge, Source, Squad } from "../shared/app-types";

const memory = vi.hoisted(() => ({ records: new Map<string, unknown>(), locks: new Map<string, Promise<void>>() }));
vi.mock("./features/store", () => ({
  list: async (kind: string) => [...memory.records.entries()].filter(([key]) => key.startsWith(kind + "/")).map(([, value]) => structuredClone(value)),
  get: async (kind: string, id: string) => structuredClone(memory.records.get(`${kind}/${id}`)),
  create: async (kind: string, _owner: number, value: { id: string }) => {
    const key = `${kind}/${value.id}`;
    if (memory.records.has(key)) throw Object.assign(new Error("Duplicate"), { code: "ER_DUP_ENTRY" });
    memory.records.set(key, structuredClone(value)); return structuredClone(value);
  },
  mutate: async (kind: string, id: string, fn: (value: any) => any) => {
    const key = `${kind}/${id}`, previous = memory.locks.get(key) || Promise.resolve();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    memory.locks.set(key, previous.then(() => held)); await previous;
    try {
      if (!memory.records.has(key)) throw Object.assign(new Error("Record not found"), { status: 404 });
      const next = fn(structuredClone(memory.records.get(key)));
      memory.records.set(key, structuredClone(next)); return structuredClone(next);
    } finally { release(); }
  },
}));
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: async (req: Request) => {
  const id = Number(req.headers.authorization?.replace("Bearer ", ""));
  if (!Number.isInteger(id) || id <= 0) throw new Error("Unauthenticated test request");
  return { id, name: `Test member ${id}`, openId: `test-${id}` };
} } }));
import { registerCommunityRoutes } from "./features/community";
import { getLivePlayback, getLiveReplay, rewriteLiveManifest } from "./features/live";

let server: Server, origin: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); registerCommunityRoutes(app);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.on("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(() => {
  memory.records.clear(); memory.locks.clear(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  vi.stubEnv("RESPAWN_CF_TOKEN", ""); vi.stubEnv("RESPAWN_CF_ACCOUNT_ID", "");
  vi.stubEnv("MANUS_JWT_SECRET", "unit-test-secret-not-production");
});
async function request(path: string, userId?: number, method = "GET", body?: unknown, crossSite = false) {
  const response = await fetch(origin + path, { method, headers: {
    ...(userId ? { Authorization: `Bearer ${userId}` } : {}), ...(method !== "GET" ? { Origin: crossSite ? "https://outside.example" : origin, "Content-Type": "application/json" } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); return { status: response.status, data };
}
function squad(id: string, overrides: Partial<Squad> = {}): Squad {
  return { id, ownerId: 1, ownerName: "Owner", title: "Current squad", game: "Valorant", platform: "PC", mic: "required", startsAt: new Date(Date.now() + 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), capacity: 2, members: [1], requests: [], vibe: "Chill", createdAt: new Date().toISOString(), ...overrides };
}
function source(overrides: Partial<Source> = {}): Source {
  return { id: "source-one", creatorId: 1, creatorName: "Owner", title: "Broadcast", game: "Valorant", kind: "live", audience: "public", allowClip: "creator", allowPublish: false, allowDownload: false, duration: 0, status: "offline", transcript: [], createdAt: new Date().toISOString(), ...overrides };
}

describe("real community routes with a mocked durable row-lock contract", () => {
  it("requires authentication, same-origin writes, and explicit membership confirmation", async () => {
    expect((await request("/api/app/lounges", undefined, "POST", { name: "Lounge", privacy: "public" })).status).toBe(401);
    expect((await request("/api/app/lounges", 1, "POST", { name: "Lounge", privacy: "public" }, true)).status).toBe(403);
    const created = await request("/api/app/lounges", 1, "POST", { name: "Real Lounge", privacy: "public", game: "Valorant" });
    expect(created.status).toBe(201); expect(created.data.members).toEqual([1]);
    expect((await request(`/api/app/lounges/${created.data.id}/join`, 2, "POST", { confirmed: false })).status).toBe(400);
  });
  it("private invites reveal no private data; only the owner approves actual pending requests", async () => {
    const created = await request("/api/app/lounges", 1, "POST", { name: "Private Lounge", description: "Private content", privacy: "private" });
    const path = `/api/app/lounges/${created.data.id}`;
    expect((await request("/api/app/lounges", 2)).data).toEqual([]);
    const pending = await request(path + "/join", 2, "POST", { confirmed: true });
    expect(pending.data).toEqual({ requested: true, id: created.data.id });
    await request(path + "/join", 2, "POST", { confirmed: true });
    expect((await request("/api/app/lounges", 1)).data[0].requests).toHaveLength(1);
    expect((await request(path + "/approve", 3, "POST", { userId: 2, confirmed: true })).status).toBe(403);
    expect((await request(path + "/approve", 1, "POST", { userId: 99, confirmed: true })).status).toBe(404);
    expect((await request(path + "/approve", 1, "POST", { userId: 2, confirmed: true })).status).toBe(200);
    const memberView = (await request("/api/app/lounges", 2)).data;
    expect(memberView[0].members).toEqual([1, 2]); expect(memberView[0].requests).toEqual([]);
  });
  it("never discloses other members' membership requests on a public Lounge", async () => {
    const created = await request("/api/app/lounges", 1, "POST", { name: "Public Lounge", privacy: "public" });
    await request(`/api/app/lounges/${created.data.id}/join`, 2, "POST", { confirmed: true });
    expect((await request("/api/app/lounges")).data[0].requests).toEqual([]);
    expect((await request("/api/app/lounges", 3)).data[0].requests).toEqual([]);
    expect((await request("/api/app/lounges", 2)).data[0].requests).toHaveLength(1);
  });
  it("filters full/expired squads for outsiders while retaining the owner's own records", async () => {
    memory.records.set("squad/open", squad("open"));
    memory.records.set("squad/full", squad("full", { members: [1, 2] }));
    memory.records.set("squad/expired", squad("expired", { expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect((await request("/api/app/squads", 2)).data.map((value: Squad) => value.id)).toEqual(["open"]);
    expect((await request("/api/app/squads", 1)).data).toHaveLength(3);
    expect((await request("/api/app/squads?game=Apex", 2)).data).toEqual([]);
    expect((await request("/api/app/squads/full/join", 3, "POST", { confirmed: true })).status).toBe(409);
    expect((await request("/api/app/squads/expired/join", 3, "POST", { confirmed: true })).status).toBe(409);
  });
  it("rechecks live capacity atomically on concurrent approvals", async () => {
    memory.records.set("squad/open", squad("open"));
    await Promise.all([request("/api/app/squads/open/join", 2, "POST", { confirmed: true }), request("/api/app/squads/open/join", 3, "POST", { confirmed: true })]);
    const forbidden = await request("/api/app/squads/open/approve", 3, "POST", { userId: 2, confirmed: true }); expect(forbidden.status).toBe(403);
    const results = await Promise.all([request("/api/app/squads/open/approve", 1, "POST", { userId: 2, confirmed: true }), request("/api/app/squads/open/approve", 1, "POST", { userId: 3, confirmed: true })]);
    expect(results.map(value => value.status).sort()).toEqual([200, 409]);
    const final = memory.records.get("squad/open") as Squad; expect(final.members).toHaveLength(2); expect(final.requests).toHaveLength(1);
  });
  it("rechecks expiry at approval time rather than trusting the original listing", async () => {
    memory.records.set("squad/open", squad("open", { requests: [{ userId: 2, name: "Applicant", createdAt: new Date().toISOString() }], expiresAt: new Date(Date.now() - 1).toISOString() }));
    expect((await request("/api/app/squads/open/approve", 1, "POST", { userId: 2, confirmed: true })).status).toBe(409);
    expect((memory.records.get("squad/open") as Squad).members).toEqual([1]);
  });
  it("saves explicit identity settings without gaming memory consent and preserves operational duration on clear", async () => {
    let result = await request("/api/app/settings", 1, "PATCH", { name: "Chosen identity", avatar: "spark", accent: "British", tone: "Hype", games: ["Valorant"], clipDuration: 60, enabled: false });
    expect(result.data.name).toBe("Chosen identity"); expect(result.data.avatar).toBe("spark"); expect(result.data.accent).toBe("British"); expect(result.data.tone).toBe("Hype");
    expect(result.data.games).toEqual([]); expect(result.data.clipDuration).toBe(60); expect(result.data.id).toBeUndefined(); expect(result.data.ownerId).toBeUndefined();
    result = await request("/api/app/settings", 1, "PATCH", { personalization: true, enabled: true, name: "Saved Name", games: ["Valorant"], platform: "Console", tone: "Hype" });
    expect(result.data.name).toBe("Saved Name"); expect((await request("/api/app/settings", 2)).data.name).not.toBe("Saved Name");
    const memoryOff = await request("/api/app/settings", 1, "PATCH", { personalization: false });
    expect(memoryOff.data.name).toBe("Saved Name"); expect(memoryOff.data.games).toEqual([]); expect(memoryOff.data.platform).toBe("PC");
    const cleared = await request("/api/app/settings", 1, "DELETE");
    expect(cleared.data.personalization).toBe(false); expect(cleared.data.clipDuration).toBe(60); expect(cleared.data.enabled).toBe(true); expect(cleared.data.games).toEqual([]); expect(cleared.data.tone).toBe("Chill");
    expect(cleared.data.name).toBe("Nova"); expect(cleared.data.avatar).toBe("orbit"); expect(cleared.data.accent).toBe("#C6F36A");
    expect((await request("/api/app/settings", 1, "PATCH", { clipDuration: 10 })).status).toBe(400);
  });
  it("persists actual Studio title/game/schedule and denies another creator's source", async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    expect((await request("/api/app/studio", 1, "PATCH", { title: "New broadcast title", game: "Valorant", scheduledAt })).status).toBe(200);
    const saved = (await request("/api/app/studio", 1)).data;
    expect(saved.title).toBe("New broadcast title"); expect(saved.scheduledAt).toBe(scheduledAt); expect(saved.connected).toBe(false); expect(saved.streamKey).toBeUndefined();
    memory.records.set("source/source-one", source({ creatorId: 2 }));
    expect((await request("/api/app/studio", 1, "PATCH", { sourceId: "source-one" })).status).toBe(403);
    expect((await request("/api/app/studio", 1, "PATCH", { connected: true })).status).toBe(400);
  });
  it("returns honest 503 with no live input, source, or connected flag when provider setup is deferred", async () => {
    const response = await request("/api/app/studio/connect", 1, "POST", { confirmed: true });
    expect(response.status).toBe(503); expect(response.data.error).toMatch(/deferred/i); expect(response.data.connected).toBeUndefined();
    expect(memory.records.size).toBe(0); expect(await getLiveReplay(source())).toBeNull(); expect(await getLivePlayback(source())).toBeNull();
  });
});

describe("live private resource proxy authorization", () => {
  it("rewrites both nested playlists and URI attributes without exposing signed upstream tokens", () => {
    const upstream = "https://customer-test.cloudflarestream.com/private-provider-token/manifest/video.m3u8";
    const body = rewriteLiveManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key"\nvariant/video.m3u8\n', upstream, "source-one");
    expect(body).not.toContain("private-provider-token"); expect(body).not.toContain("cloudflarestream.com"); expect(body.match(/\/api\/live\/source\/source-one\/resource/g)).toHaveLength(2);
  });
  it("denies a nonmember and rechecks membership on each media request", async () => {
    const privateSource = source({ audience: "lounge", loungeId: "private" });
    const lounge: Lounge = { id: "private", ownerId: 1, name: "Private", description: "", game: "", privacy: "private", members: [1, 2], requests: [], createdAt: new Date().toISOString() };
    memory.records.set("source/source-one", privateSource); memory.records.set("lounge/private", lounge);
    const manifest = rewriteLiveManifest("#EXTM3U\nsegment.ts\n", "https://customer-test.cloudflarestream.com/token/manifest/video.m3u8", "source-one");
    const path = manifest.split("\n")[1];
    expect((await request(path, 3)).status).toBe(403);
    memory.records.set("lounge/private", { ...lounge, members: [1] });
    expect((await request(path, 2)).status).toBe(403);
  });
});
