import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { User } from "../../drizzle/schema";
import type { Lounge } from "../../shared/app-types";
import type { ClipRecord, SourceRecord } from "./processing";

const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  identity: null as User | null,
  jobs: [] as unknown[],
  upstream: "",
}));
vi.mock("./store", () => ({
  list: async (kind: string) =>
    [...fake.records.entries()]
      .filter(([key]) => key.startsWith(kind + ":"))
      .map(([, value]) => structuredClone(value)),
  get: async (kind: string, id: string) => {
    const value = fake.records.get(kind + ":" + id);
    return value ? structuredClone(value) : undefined;
  },
  create: async (kind: string, _owner: number, value: any) => {
    fake.records.set(kind + ":" + value.id, structuredClone(value));
    return value;
  },
  mutate: async (kind: string, id: string, fn: (value: any) => any) => {
    const key = kind + ":" + id,
      value = fake.records.get(key);
    if (!value) throw Object.assign(new Error("Missing"), { status: 404 });
    const next = fn(structuredClone(value));
    fake.records.set(key, next);
    return next;
  },
  database: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (fake.identity ? [fake.identity] : []),
        }),
      }),
    }),
  }),
}));
vi.mock("../_core/sdk", () => ({
  sdk: {
    authenticateRequest: async () => {
      if (!fake.identity) throw new Error("Invalid session");
      return fake.identity;
    },
  },
}));
vi.mock("./processing", async importOriginal => ({
  ...(await importOriginal<typeof import("./processing")>()),
  startMediaWorker: vi.fn(),
  putFile: vi.fn(async () => "SCRATCH-STORAGE-KEY"),
  enqueueJob: async (...args: unknown[]) => {
    fake.jobs.push(args);
  },
}));
vi.mock("../storage", () => ({
  storageGetSignedUrl: vi.fn(async () => {
    if (fake.upstream) return fake.upstream;
    throw new Error("Private denial must happen before storage");
  }),
}));
import {
  canClipSource,
  canReadClip,
  canReadSource,
  mediaTicket,
  publicClip,
  publicSource,
  ticketUser,
} from "./access";
import {
  clipInterval,
  createClip,
  parseRange,
  registerMediaRoutes,
  updateClip,
} from "./media";

const user = (id: number): User => ({
  id,
  openId: `test-${id}`,
  name: `Test ${id}`,
  email: null,
  loginMethod: null,
  role: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSignedIn: new Date(),
});
const original: SourceRecord = {
  id: "source-a",
  creatorId: 1,
  creatorName: "Creator",
  title: "Original",
  game: "Test",
  kind: "upload",
  audience: "public",
  allowClip: "everyone",
  allowPublish: true,
  allowDownload: true,
  duration: 90,
  status: "ready",
  createdAt: new Date().toISOString(),
  transcript: [],
  objectKey: "SECRET-OBJECT-KEY",
  rawKey: "SECRET-RAW-KEY",
  posterKey: "SECRET-POSTER-KEY",
};
const privateLounge: Lounge = {
  id: "private-a",
  ownerId: 1,
  name: "Private",
  description: "",
  game: "",
  privacy: "private",
  members: [1, 2],
  requests: [],
  createdAt: new Date().toISOString(),
};
const sampleClip: ClipRecord = {
  id: "clip-a",
  ownerId: 2,
  ownerName: "Test 2",
  sourceId: original.id,
  creatorId: 1,
  creatorName: "Creator",
  title: "Clip",
  game: "",
  start: 0,
  end: 12,
  crop: "original",
  cropX: 0.5,
  cropY: 0.5,
  captions: [],
  overlay: "",
  audience: "public",
  status: "ready",
  published: true,
  createdAt: new Date().toISOString(),
  outputKey: "SECRET-OUTPUT-KEY",
  posterKey: "SECRET-CLIP-POSTER",
  renderVersion: 1,
};
let server: Server | undefined;
let base = "";
beforeEach(() => {
  fake.records.clear();
  fake.identity = null;
  fake.jobs.length = 0;
  fake.records.set("source:" + original.id, structuredClone(original));
  fake.records.set(
    "lounge:" + privateLounge.id,
    structuredClone(privateLounge)
  );
  fake.records.set("clip:" + sampleClip.id, structuredClone(sampleClip));
  process.env.MANUS_JWT_SECRET = "only-a-test-secret-not-production";
  process.env.MANUS_PROJECT_ID = "only-a-test-project";
  vi.stubEnv("MANUS_API_URL", "http://127.0.0.1:9/not-a-live-provider");
  vi.stubEnv("MANUS_API_KEY", "test-only-not-production");
});
afterAll(async () => {
  if (server)
    await new Promise<void>(resolve => server!.close(() => resolve()));
  vi.unstubAllEnvs();
});
async function app() {
  if (!server) {
    const instance = express();
    instance.use(express.json());
    registerMediaRoutes(instance);
    server = instance.listen(0);
    await new Promise(resolve => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  return base;
}
function privateSource() {
  const source: SourceRecord = {
    ...original,
    audience: "lounge",
    loungeId: privateLounge.id,
  };
  fake.records.set("source:" + source.id, source);
  return source;
}

describe("audience and consent", () => {
  it("does not reveal a private original or published clip to anonymous users or outsiders", async () => {
    const source = privateSource();
    fake.records.set("clip:" + sampleClip.id, {
      ...sampleClip,
      audience: "lounge",
      loungeId: privateLounge.id,
    });
    expect(await canReadSource(source)).toBe(false);
    expect(await canReadSource(source, 3)).toBe(false);
    expect(await canReadSource(source, 2)).toBe(true);
    expect(
      await canReadClip(fake.records.get("clip:" + sampleClip.id), 3)
    ).toBe(false);
  });
  it("requires original access even when a tray clip belongs to the former member", async () => {
    privateSource();
    fake.records.set("lounge:" + privateLounge.id, {
      ...privateLounge,
      members: [1],
    });
    expect(await canReadClip({ ...sampleClip, published: false }, 2)).toBe(
      false
    );
  });
  it("enforces separate clipping consent", async () => {
    expect(await canClipSource({ ...original, allowClip: "creator" }, 2)).toBe(
      false
    );
    expect(await canClipSource({ ...original, allowClip: "creator" }, 1)).toBe(
      true
    );
    await expect(
      createClip(user(2), { sourceId: original.id, position: 12, duration: 30 })
    ).resolves.toMatchObject({ start: 0, end: 12, published: false });
    expect(fake.jobs).toHaveLength(1);
  });
  it("does not broaden private clip audience on creation or editor mutations", async () => {
    privateSource();
    const clip = await createClip(user(2), {
      sourceId: original.id,
      position: 12,
      duration: 60,
    });
    expect(clip).toMatchObject({
      start: 0,
      end: 12,
      audience: "lounge",
      loungeId: privateLounge.id,
    });
    await expect(
      updateClip(user(2), clip.id, { audience: "public" })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateClip(user(3), clip.id, { title: "Stolen" })
    ).rejects.toMatchObject({ status: 403 });
  });
  it("never outputs storage keys, raw URLs, job metadata or provider credentials", () => {
    const source = publicSource({
      ...original,
      playbackUrl: "https://secret-storage.invalid",
      liveInputId: "secret-id",
    });
    const clip = publicClip(sampleClip);
    expect(JSON.stringify({ source, clip })).not.toMatch(
      /SECRET|secret-storage|renderVersion|rawKey|objectKey|outputKey|liveInputId/
    );
    expect(source.playbackUrl).toBe(`/api/media/source/${original.id}`);
  });
  it("rejects a token scoped to another resource or tampered token", async () => {
    fake.identity = user(2);
    const ticket = mediaTicket(`clip/${sampleClip.id}`, 2);
    expect(
      await ticketUser({ query: { ticket } } as any, `source/${original.id}`)
    ).toBeNull();
    expect(
      await ticketUser(
        { query: { ticket: ticket + "x" } } as any,
        `clip/${sampleClip.id}`
      )
    ).toBeNull();
    expect(
      (await ticketUser({ query: { ticket } } as any, `clip/${sampleClip.id}`))
        ?.id
    ).toBe(2);
  });
});
describe("player intervals and editor", () => {
  it("captures previous 15/30/60 seconds from viewed source position, including the early 12-second case", () => {
    for (const duration of [15, 30, 60] as const)
      expect(clipInterval(12, duration, 90)).toEqual({ start: 0, end: 12 });
    expect(clipInterval(75, 30, 90)).toEqual({ start: 45, end: 75 });
    expect(clipInterval(999, 15, 90)).toEqual({ start: 75, end: 90 });
    for (const position of [NaN, Infinity, -1, 0])
      expect(() => clipInterval(position, 30, 90)).toThrow();
  });
  it("validates finite edits, preserves credit and rerenders", async () => {
    await expect(
      updateClip(user(2), sampleClip.id, { start: NaN })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      updateClip(user(2), sampleClip.id, { start: 0, end: 75 })
    ).rejects.toMatchObject({ status: 400 });
    const clip = await updateClip(user(2), sampleClip.id, {
      crop: "vertical",
      cropX: 100,
      cropY: -100,
      captions: [{ start: 1, end: 2, text: "Real caption" }],
      overlay: "🎮",
    });
    expect(clip).toMatchObject({
      crop: "vertical",
      cropX: 1,
      cropY: 0,
      creatorId: 1,
      creatorName: "Creator",
      published: false,
      status: "queued",
    });
  });
  it("keeps unmapped live player times honest bookmarks", async () => {
    fake.records.set("source:" + original.id, {
      ...original,
      kind: "live",
      status: "live",
      objectKey: undefined,
      duration: 0,
      recordingId: "broadcast-a",
    });
    const clip = await createClip(user(2), {
      sourceId: original.id,
      position: 12,
      duration: 30,
    });
    expect(clip.status).toBe("bookmarked");
    expect(clip.footageNote).toContain("not verified");
    expect(fake.jobs).toHaveLength(0);
  });
  it("filters valid supplied captions wholly beyond a shortened range, but rejects originally malformed intervals", async () => {
    const clip = await updateClip(user(2), sampleClip.id, {
      end: 5,
      captions: [
        { start: 7, end: 9, text: "Outside trim" },
        { start: -2, end: -1, text: "Before trim" },
        { start: 4, end: 8, text: "Partial overlap" },
      ],
    });
    expect(clip.captions).toEqual([
      { start: 4, end: 5, text: "Partial overlap" },
    ]);
    for (const captions of [
      [{ start: 9, end: 7, text: "Reversed outside" }],
      [{ start: 7, end: 7, text: "Empty outside" }],
      [
        { start: 0, end: 1, text: "Valid" },
        { start: Infinity, end: 9, text: "Invalid" },
      ],
    ])
      await expect(
        updateClip(user(2), sampleClip.id, { captions })
      ).rejects.toMatchObject({ status: 400 });
  });
  it("shifts retained clip-relative captions when the source-relative start moves", async () => {
    fake.records.set("clip:" + sampleClip.id, {
      ...sampleClip,
      captions: [
        { start: 1, end: 2, text: "Removed" },
        { start: 4, end: 6, text: "Shifted" },
      ],
    });
    expect(
      (await updateClip(user(2), sampleClip.id, { start: 3, end: 8 })).captions
    ).toEqual([{ start: 1, end: 3, text: "Shifted" }]);
  });
  it("bounds each range to 8MiB and denies malformed or outside ranges", () => {
    expect(parseRange("bytes=0-99999999", 100_000_000)).toEqual({
      start: 0,
      end: 8 * 1024 * 1024 - 1,
      partial: true,
    });
    expect(() => parseRange("bytes=0-1,3-4", 100)).toThrow();
    expect(() => parseRange("bytes=100-", 100)).toThrow();
  });
});
describe("HTTP enforcement", () => {
  it("requires literal paid-speech confirmation for both source and clip transcription", async () => {
    const origin = await app();
    for (const resource of ["sources", "clips"]) {
      fake.identity = user(resource === "sources" ? 1 : 2);
      for (const body of [{}, { confirmed: false }, { confirmed: "true" }]) {
        const response = await fetch(
          `${origin}/api/app/${resource}/${resource === "sources" ? original.id : sampleClip.id}/transcribe`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: origin },
            body: JSON.stringify(body),
          }
        );
        expect(response.status).toBe(400);
      }
    }
    expect(fake.jobs).toHaveLength(0);
  });
  it("queues creator transcript generation only after confirmation and reports a stable source poll state", async () => {
    fake.identity = user(1);
    const origin = await app();
    const request = () =>
      fetch(`${origin}/api/app/sources/${original.id}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ confirmed: true }),
      });
    const queued = await request();
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({
      id: original.id,
      status: "ready",
      transcriptionStatus: "queued",
    });
    expect((await request()).status).toBe(202);
    expect(fake.jobs).toEqual([["transcribe", original.id, 1, 2]]);
    expect(
      await (await fetch(`${origin}/api/app/sources/${original.id}`)).json()
    ).toMatchObject({ transcriptionStatus: "queued", transcript: [] });
  });
  it("a clip owner can transcribe their clip, never mutate the creator source, and repeated requests do not enqueue paid duplicates", async () => {
    fake.identity = user(2);
    const origin = await app();
    const before = structuredClone(fake.records.get("source:" + original.id));
    const request = (resource: string, id: string) =>
      fetch(`${origin}/api/app/${resource}/${id}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ confirmed: true }),
      });
    expect((await request("sources", original.id)).status).toBe(403);
    const queued = await request("clips", sampleClip.id);
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({
      id: sampleClip.id,
      status: "ready",
      transcriptionStatus: "queued",
    });
    expect((await request("clips", sampleClip.id)).status).toBe(202);
    expect(fake.jobs).toEqual([["clip-transcribe", sampleClip.id, 2, 1]]);
    expect(fake.records.get("source:" + original.id)).toEqual(before);
    const poll = await fetch(`${origin}/api/app/clips/${sampleClip.id}`);
    expect(await poll.json()).toMatchObject({ transcriptionStatus: "queued" });
    const editing = await fetch(`${origin}/api/app/clips/${sampleClip.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ title: "Concurrent change" }),
    });
    expect(editing.status).toBe(409);
  });
  it("denies clip transcription to nonowners, removed private members, unready cuts, and cross-origin callers", async () => {
    const origin = await app();
    const request = (originHeader = origin) =>
      fetch(`${origin}/api/app/clips/${sampleClip.id}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: originHeader },
        body: JSON.stringify({ confirmed: true }),
      });
    fake.identity = null;
    expect((await request()).status).toBe(401);
    fake.identity = user(1);
    expect((await request()).status).toBe(403);
    fake.identity = user(2);
    expect((await request("https://outside.invalid")).status).toBe(403);
    privateSource();
    fake.records.set("lounge:" + privateLounge.id, {
      ...privateLounge,
      members: [1],
    });
    expect((await request()).status).toBe(403);
    fake.records.set("source:" + original.id, structuredClone(original));
    fake.records.set("clip:" + sampleClip.id, {
      ...sampleClip,
      status: "queued",
      outputKey: undefined,
    });
    expect((await request()).status).toBe(409);
    expect(fake.jobs).toHaveLength(0);
  });
  it("proxies bounded media bytes without exposing or redirecting to the upstream URL", async () => {
    const scratch = express();
    const bytes = Buffer.alloc(9 * 1024 * 1024, 0x42);
    scratch.get("/scratch", (req, res) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.get("range") ?? "");
      const start = Number(match?.[1] ?? 0),
        end = Math.min(
          bytes.length - 1,
          Number(match?.[2] ?? bytes.length - 1)
        );
      res
        .status(206)
        .set({
          "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
          "Content-Length": String(end - start + 1),
        })
        .send(bytes.subarray(start, end + 1));
    });
    const upstream = scratch.listen(0);
    await new Promise(resolve => upstream.once("listening", resolve));
    fake.upstream = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/scratch`;
    try {
      fake.identity = user(2);
      const origin = await app();
      const response = await fetch(
        `${origin}/api/media/clip/${sampleClip.id}`,
        { headers: { Range: "bytes=0-99999999" } }
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-range")).toBe(
        `bytes 0-${8 * 1024 * 1024 - 1}/${bytes.length}`
      );
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect((await response.arrayBuffer()).byteLength).toBe(8 * 1024 * 1024);
      const tail = await fetch(`${origin}/api/media/clip/${sampleClip.id}`, {
        headers: { Range: `bytes=${8 * 1024 * 1024}-` },
      });
      expect((await tail.arrayBuffer()).byteLength).toBe(1024 * 1024);
      privateSource();
      fake.records.set("lounge:" + privateLounge.id, {
        ...privateLounge,
        members: [1],
      });
      expect(
        (await fetch(`${origin}/api/media/clip/${sampleClip.id}`)).status
      ).toBe(404);
    } finally {
      fake.upstream = "";
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
  it("rejects outsider private multipart upload and missing pre-file audience context", async () => {
    fake.identity = user(3);
    const origin = await app();
    const denied = new FormData();
    denied.append("audience", "lounge");
    denied.append("loungeId", privateLounge.id);
    denied.append(
      "file",
      new Blob(["not-media"], { type: "video/mp4" }),
      "scratch.mp4"
    );
    const response = await fetch(`${origin}/api/app/upload`, {
      method: "POST",
      headers: { Origin: origin },
      body: denied,
    });
    expect(response.status).toBe(403);
    const missing = new FormData();
    missing.append(
      "file",
      new Blob(["not-media"], { type: "video/mp4" }),
      "scratch.mp4"
    );
    missing.append("audience", "public");
    expect(
      (
        await fetch(`${origin}/api/app/upload`, {
          method: "POST",
          headers: { Origin: origin },
          body: missing,
        })
      ).status
    ).toBe(400);
  });
  it("denies outside private playback and download before contacting storage", async () => {
    privateSource();
    fake.records.set("clip:" + sampleClip.id, {
      ...sampleClip,
      audience: "lounge",
      loungeId: privateLounge.id,
    });
    fake.identity = user(3);
    const origin = await app();
    for (const route of [
      `/api/media/source/${original.id}`,
      `/api/media/clip/${sampleClip.id}`,
      `/api/media/download/${sampleClip.id}`,
    ]) {
      const response = await fetch(origin + route);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("SECRET");
    }
  });
  it("requires confirmation and prevents private profile publication", async () => {
    privateSource();
    fake.records.set("clip:" + sampleClip.id, {
      ...sampleClip,
      audience: "lounge",
      loungeId: privateLounge.id,
    });
    fake.identity = user(2);
    const origin = await app();
    const response = await fetch(
      `${origin}/api/app/clips/${sampleClip.id}/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ destination: "profile", confirmed: true }),
      }
    );
    expect(response.status).toBe(403);
  });
  it("rejects cross-origin changes and does not bypass source publish consent", async () => {
    fake.identity = user(2);
    const origin = await app();
    const forged = await fetch(`${origin}/api/app/clips/${sampleClip.id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://outside.invalid",
      },
      body: JSON.stringify({ title: "Forged" }),
    });
    expect(forged.status).toBe(403);
    fake.records.set("source:" + original.id, {
      ...original,
      allowPublish: false,
    });
    const denied = await fetch(
      `${origin}/api/app/clips/${sampleClip.id}/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ destination: "profile", confirmed: true }),
      }
    );
    expect(denied.status).toBe(403);
  });
  it("Undo soft-deletes a clip so it cannot be played afterwards", async () => {
    fake.identity = user(2);
    const origin = await app();
    const undone = await fetch(`${origin}/api/app/clips/${sampleClip.id}`, {
      method: "DELETE",
      headers: { Origin: origin },
    });
    expect(undone.status).toBe(200);
    expect(
      (await fetch(`${origin}/api/media/clip/${sampleClip.id}`)).status
    ).toBe(404);
  });
});
