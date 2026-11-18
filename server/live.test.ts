import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Source } from "../shared/app-types";
import type { User } from "../drizzle/schema";
import type { StudioRecord } from "./features/community";

const memory = vi.hoisted(() => ({ records: new Map<string, any>() }));
vi.mock("./features/store", () => ({
  list: async (kind: string) => [...memory.records.entries()].filter(([key]) => key.startsWith(kind + "/")).map(([, value]) => structuredClone(value)),
  get: async (kind: string, id: string) => structuredClone(memory.records.get(`${kind}/${id}`)),
  create: async (kind: string, _owner: number, value: { id: string }) => {
    const key = `${kind}/${value.id}`;
    if (memory.records.has(key)) throw Object.assign(new Error("Duplicate"), { code: "ER_DUP_ENTRY" });
    memory.records.set(key, structuredClone(value)); return structuredClone(value);
  },
  mutate: async (kind: string, id: string, fn: (value: any) => any) => {
    const key = `${kind}/${id}`;
    if (!memory.records.has(key)) throw Object.assign(new Error("Missing"), { status: 404 });
    const next = fn(structuredClone(memory.records.get(key)));
    memory.records.set(key, structuredClone(next)); return structuredClone(next);
  },
}));
vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
import { createLiveInput, getLivePlayback, getLiveReplay, reconcileStudio } from "./features/live";

const user = { id: 1, name: "Test owner" } as User;
function source(overrides: Partial<Source> = {}): Source {
  return { id: "source-one", creatorId: 1, creatorName: "Owner", title: "Broadcast", game: "Valorant", kind: "live", audience: "public", allowClip: "creator", allowPublish: false, allowDownload: false, duration: 0, status: "offline", transcript: [], createdAt: new Date().toISOString(), liveInputId: "input", recordingId: "video-one", ...overrides };
}
function studio(overrides: Partial<StudioRecord> = {}): StudioRecord {
  return { id: "studio:1", ownerId: 1, title: "A real title", game: "Valorant", provider: "Cloudflare Stream", connected: false, ...overrides };
}
function provider(handler: (path: string, init: RequestInit) => unknown) {
  return vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace("/client/v4/accounts/account/stream", "");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer configured-test-token");
    const result = handler(path, init);
    return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}
beforeEach(() => {
  memory.records.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  vi.stubEnv("RESPAWN_CF_TOKEN", "configured-test-token"); vi.stubEnv("RESPAWN_CF_ACCOUNT_ID", "account");
});

describe("documentation-verified Cloudflare API contract (network mocked)", () => {
  it("does not guess a replay from a live Input ID when no recording is pinned", async () => {
    provider(() => { throw new Error("No provider request expected"); });
    expect(await getLiveReplay(source({ recordingId: undefined }))).toBeNull();
    expect(await getLivePlayback(source({ recordingId: undefined }))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps live captures bookmarked until the exact recording is ready", async () => {
    provider(path => { expect(path).toBe("/video-one"); return { uid: "video-one", readyToStream: true, status: { state: "live-inprogress" }, duration: 100 }; });
    expect(await getLiveReplay(source())).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires finished video readiness and generated MP4 readiness before replay", async () => {
    provider(path => {
      if (path === "/video-one") return { uid: "video-one", readyToStream: true, status: { state: "ready" }, duration: 123 };
      if (path === "/video-one/downloads") return { default: { status: "inprogress", url: "https://customer-test.cloudflarestream.com/video-one/downloads/default.mp4" } };
      throw new Error(`Unexpected ${path}`);
    });
    expect(await getLiveReplay(source())).toBeNull(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("uses verified downloads and a short-lived downloadable token for the pinned MP4", async () => {
    provider((path, init) => {
      if (path === "/video-one") return { uid: "video-one", readyToStream: true, status: { state: "ready" }, duration: 123 };
      if (path === "/video-one/downloads") return { default: { status: "ready", url: "https://customer-test.cloudflarestream.com/video-one/downloads/default.mp4" } };
      if (path === "/video-one/token") {
        expect(init.method).toBe("POST"); const body = JSON.parse(init.body as string);
        expect(body.downloadable).toBe(true); expect(body.exp).toBeGreaterThan(Date.now() / 1000); expect(body.exp).toBeLessThan(Date.now() / 1000 + 301);
        return { token: "private-download-token" };
      }
      throw new Error(`Unexpected ${path}`);
    });
    const replay = await getLiveReplay(source());
    expect(replay).toEqual({ duration: 123, url: "https://customer-test.cloudflarestream.com/private-download-token/downloads/default.mp4" });
  });
  it("generates an absent MP4 but does not claim generation means ready", async () => {
    provider((path, init) => {
      if (path === "/video-one") return { uid: "video-one", readyToStream: true, status: { state: "ready" }, duration: 123 };
      if (path === "/video-one/downloads") return init.method === "POST" ? { default: { status: "inprogress" } } : {};
      throw new Error(`Unexpected ${path}`);
    });
    expect(await getLiveReplay(source())).toBeNull(); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("returns server-only signed HLS DVR for the exact broadcast without download scope", async () => {
    provider((path, init) => {
      if (path === "/video-one") return { uid: "video-one", readyToStream: true, status: { state: "live-inprogress" }, playback: { hls: "https://customer-test.cloudflarestream.com/video-one/manifest/video.m3u8" } };
      if (path === "/video-one/token") { expect(JSON.parse(init.body as string).downloadable).toBeUndefined(); return { token: "private-playback-token" }; }
      throw new Error(`Unexpected ${path}`);
    });
    expect(await getLivePlayback(source())).toBe("https://customer-test.cloudflarestream.com/private-playback-token/manifest/video.m3u8?dvrEnabled=true");
  });
  it("creates automatic-recording signed input but never starts or reports a broadcast", async () => {
    const saved = studio(); memory.records.set("studio/studio:1", saved);
    provider((path, init) => {
      expect(path).toBe("/live_inputs"); expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string); expect(body.recording.mode).toBe("automatic"); expect(body.recording.requireSignedURLs).toBe(true);
      return { uid: "input", rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: "owner-only-stream-key" } };
    });
    const result = await createLiveInput(user, saved);
    expect(result.studio.connected).toBe(true); expect(result.source.status).toBe("offline"); expect(result.source.recordingId).toBeUndefined();
    expect(result.streamKey).toBe("owner-only-stream-key"); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not create a duplicate input while durable provisioning is pending", async () => {
    const saved = studio({ provisionState: "creating" }); memory.records.set("studio/studio:1", saved);
    provider(() => { throw new Error("No request expected"); });
    await expect(createLiveInput(user, saved)).rejects.toMatchObject({ status: 409 }); expect(fetch).not.toHaveBeenCalled();
  });
  it("does not rebind an existing source/clip to a later broadcast or inherit its storage keys", async () => {
    const saved = studio({ liveInputId: "input", sourceId: "source-one", connected: true });
    memory.records.set("studio/studio:1", saved);
    memory.records.set("source/source-one", { ...source({ transcript: [{ start: 1, end: 2, text: "Old broadcast" }] }), objectKey: "private-old-object" });
    provider(path => {
      if (path === "/live_inputs/input") return { uid: "input", status: "connected" };
      if (path === "/live_inputs/input/videos") return [{ uid: "video-two", status: { state: "live-inprogress" }, readyToStream: true }, { uid: "video-one", status: { state: "ready" }, readyToStream: true, duration: 123 }];
      throw new Error(`Unexpected ${path}`);
    });
    const result = await reconcileStudio(saved);
    expect(result.sourceId).toBe("broadcast:input:video-two");
    expect(memory.records.get("source/source-one").recordingId).toBe("video-one");
    const latest = memory.records.get("source/broadcast:input:video-two"); expect(latest.recordingId).toBe("video-two"); expect(latest.transcript).toEqual([]); expect(latest.objectKey).toBeUndefined();
  });
  it("a provisioned idle input does not make the source live", async () => {
    const saved = studio({ liveInputId: "input", sourceId: "source-one" }); memory.records.set("studio/studio:1", saved); memory.records.set("source/source-one", source({ recordingId: undefined }));
    provider(path => path.endsWith("/videos") ? [] : { uid: "input", status: "disconnected" });
    const result = await reconcileStudio(saved);
    expect(result.status).toMatch(/no live broadcast/); expect(memory.records.get("source/source-one").status).toBe("offline");
  });
});
