import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import multer from "multer";
import type { Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { User } from "../../drizzle/schema";

const scratch = vi.hoisted(() => ({
  records: new Map<string, any>(),
  provider: "",
  objects: new Map<string, Buffer>(),
  speechRequests: [] as {
    model: string;
    filename: string;
    mime: string;
    bytes: Buffer;
  }[],
  gets: [] as string[],
  speechStatus: 200,
  removeAccessAtSpeech: false,
  segments: [] as { start: number; end: number; text: string }[],
  identity: null as User | null,
}));
vi.mock("./store", () => ({
  get: async (kind: string, id: string) => {
    const value = scratch.records.get(`${kind}:${id}`);
    return value ? structuredClone(value) : undefined;
  },
  list: async (kind: string) =>
    [...scratch.records.entries()]
      .filter(([key]) => key.startsWith(kind + ":"))
      .map(([, value]) => structuredClone(value)),
  create: async (kind: string, _owner: number, value: any) => {
    scratch.records.set(`${kind}:${value.id}`, structuredClone(value));
    return value;
  },
  mutate: async (kind: string, id: string, fn: (value: any) => any) => {
    const key = `${kind}:${id}`;
    const before = scratch.records.get(key);
    if (!before) throw new Error("Missing scratch record");
    const next = fn(structuredClone(before));
    scratch.records.set(key, structuredClone(next));
    return next;
  },
  database: () => ({
    // This narrowly models enqueueJob's serialized queue transaction; no DB connection exists.
    transaction: async (fn: (tx: any) => Promise<void>) => {
      let selects = 0;
      const tx = {
        select: () => {
          const index = selects++;
          const rows =
            index === 2
              ? [...scratch.records.entries()]
                  .filter(([key]) => key.startsWith("mediaJob:"))
                  .map(([, value]) => ({ payload: value }))
              : [];
          return {
            from: () => ({
              where: () => ({
                for: async () => [],
                limit: async () => [],
                then: (resolve: any) => resolve(rows),
              }),
            }),
          };
        },
        insert: () => ({
          values: async (row: any) => {
            scratch.records.set(
              `${row.kind}:${row.id}`,
              structuredClone(row.payload)
            );
          },
        }),
      };
      await fn(tx);
    },
  }),
}));
vi.mock("../storage", () => ({
  storageGetSignedUrl: vi.fn(
    async (key: string) =>
      `${scratch.provider}/objects/${encodeURIComponent(key)}`
  ),
}));
vi.mock("../_core/sdk", () => ({
  sdk: {
    authenticateRequest: async () => {
      if (!scratch.identity) throw new Error("No test identity");
      return scratch.identity;
    },
  },
}));
vi.mock("./processing", async importOriginal => ({
  ...(await importOriginal<typeof import("./processing")>()),
  startMediaWorker: vi.fn(),
}));
import {
  command,
  probeFile,
  renderClipFile,
  runMediaJob,
  type ClipRecord,
  type Job,
  type SourceRecord,
} from "./processing";
import { transcribeClip, registerMediaRoutes } from "./media";

let directory = "";
let providerServer: Server;
let applicationServer: Server;
let appOrigin = "";
const user = {
  id: 2,
  openId: "scratch-user",
  name: "Scratch owner",
  role: "user",
} as User;
const source: SourceRecord = {
  id: "scratch-source",
  creatorId: 1,
  creatorName: "Scratch creator",
  title: "Scratch source",
  game: "",
  kind: "upload",
  audience: "public",
  allowClip: "everyone",
  allowPublish: true,
  allowDownload: true,
  duration: 3,
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  objectKey: "SOURCE",
  transcript: [
    { start: 0, end: 3, text: "Existing creator transcript remains unchanged" },
  ],
};
const clip: ClipRecord = {
  id: "scratch-clip",
  sourceId: source.id,
  ownerId: 2,
  ownerName: "Scratch owner",
  creatorId: 1,
  creatorName: source.creatorName,
  title: "Scratch cut",
  game: "",
  start: 0.5,
  end: 2.5,
  crop: "original",
  cropX: 0.5,
  cropY: 0.5,
  captions: [],
  overlay: "",
  audience: "public",
  status: "ready",
  published: true,
  createdAt: source.createdAt,
  renderVersion: 1,
  outputKey: "CLIP",
};
let sourceBytes: Buffer;
let clipBytes: Buffer;
const job = (): Job => ({
  id: "scratch-paid-job",
  resourceId: clip.id,
  ownerId: 2,
  type: "clip-transcribe",
  version: 1,
  state: "running",
  attempts: 1,
  runAt: 0,
  createdAt: 0,
});
const currentClip = () => scratch.records.get(`clip:${clip.id}`) as ClipRecord;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "respawn-transcription-test-"));
  const input = path.join(directory, "source.mp4");
  await command("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "3",
    "-threads",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    input,
  ]);
  const rendered = await renderClipFile(
    input,
    clip,
    await mkdtemp(path.join(directory, "cut-"))
  );
  sourceBytes = await readFile(input);
  clipBytes = await readFile(rendered.output);
  const provider = express();
  provider.get("/objects/:key", (req, res) => {
    scratch.gets.push(req.params.key);
    const bytes = scratch.objects.get(req.params.key);
    if (!bytes) {
      res.sendStatus(404);
      return;
    }
    res.set("Content-Type", "video/mp4").send(bytes);
  });
  provider.get("/v1/storage/presign/put", (req, res) => {
    res.json({
      url: `${scratch.provider}/objects/${encodeURIComponent(String(req.query.path))}`,
    });
  });
  provider.put(
    "/objects/:key",
    express.raw({ type: "*/*", limit: "2mb" }),
    (req, res) => {
      scratch.objects.set(req.params.key, Buffer.from(req.body));
      res.sendStatus(200);
    }
  );
  provider.post(
    "/v1/audio/transcriptions",
    multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 1024 * 1024 },
    }).single("file"),
    (req, res) => {
      scratch.speechRequests.push({
        model: req.body.model,
        filename: req.file!.originalname,
        mime: req.file!.mimetype,
        bytes: req.file!.buffer,
      });
      if (scratch.removeAccessAtSpeech)
        scratch.records.set(`source:${source.id}`, {
          ...source,
          allowClip: "creator",
        });
      res.status(scratch.speechStatus).json(
        scratch.speechStatus === 200
          ? {
              text: "Mock provider transcript fixture",
              segments: scratch.segments,
            }
          : { error: "Mock provider unavailable" }
      );
    }
  );
  providerServer = provider.listen(0);
  await new Promise(resolve => providerServer.once("listening", resolve));
  scratch.provider = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}`;
  const application = express();
  application.use(express.json());
  registerMediaRoutes(application);
  applicationServer = application.listen(0);
  await new Promise(resolve => applicationServer.once("listening", resolve));
  appOrigin = `http://127.0.0.1:${(applicationServer.address() as { port: number }).port}`;
}, 30_000);
beforeEach(() => {
  scratch.records.clear();
  scratch.records.set(`source:${source.id}`, structuredClone(source));
  scratch.records.set(`clip:${clip.id}`, structuredClone(clip));
  scratch.objects.clear();
  scratch.objects.set("SOURCE", sourceBytes);
  scratch.objects.set("CLIP", clipBytes);
  scratch.gets.length = 0;
  scratch.speechRequests.length = 0;
  scratch.speechStatus = 200;
  scratch.removeAccessAtSpeech = false;
  scratch.segments = [
    { start: 0.25, end: 1.25, text: "Provider test segment" },
    { start: 1.75, end: 9, text: "Clamped to cut" },
    { start: 5, end: 7, text: "Outside cut" },
    { start: 1, end: 0.5, text: "Malformed provider segment" },
  ];
  scratch.identity = user;
  vi.stubEnv("MANUS_API_URL", scratch.provider);
  vi.stubEnv("MANUS_API_KEY", "scratch-provider-key-never-live");
  vi.stubEnv("MANUS_JWT_SECRET", "scratch-ticket-secret");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  for (const server of [applicationServer, providerServer])
    if (server)
      await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("confirmed rendered-clip transcription with a local mock API (no paid provider or production records)", () => {
  it("sends real cut audio, persists relative provider captions only on the owner's clip, then renders actual captioned MP4 bytes", async () => {
    const beforeSource = structuredClone(
      scratch.records.get(`source:${source.id}`)
    );
    await transcribeClip(user, clip.id, { confirmed: true });
    await runMediaJob(job(), AbortSignal.timeout(30_000));
    expect(scratch.gets).toEqual(["CLIP"]);
    expect(scratch.speechRequests).toHaveLength(1);
    const request = scratch.speechRequests[0]!;
    expect(request).toMatchObject({
      model: "scribe_v2",
      filename: "clip.mp3",
      mime: "audio/mpeg",
    });
    const submittedAudio = path.join(directory, "submitted.mp3");
    await writeFile(submittedAudio, request.bytes);
    expect(await probeFile(submittedAudio)).toMatchObject({
      audio: true,
      width: 0,
      height: 0,
    });
    expect((await probeFile(submittedAudio)).duration).toBeLessThan(2.25);
    expect(currentClip()).toMatchObject({
      transcriptionStatus: "ready",
      status: "queued",
      renderVersion: 2,
      published: false,
      outputKey: undefined,
      captions: [
        { start: 0.25, end: 1.25, text: "Provider test segment" },
        { start: 1.75, end: 2, text: "Clamped to cut" },
      ],
    });
    expect(scratch.records.get(`source:${source.id}`)).toEqual(beforeSource);
    const queuedRender = scratch.records.get(
      `mediaJob:job:clip:${clip.id}:2`
    ) as Job;
    expect(queuedRender).toMatchObject({
      type: "clip",
      state: "queued",
      version: 2,
      ownerId: 2,
    });
    await runMediaJob(queuedRender, AbortSignal.timeout(30_000));
    expect(currentClip()).toMatchObject({
      status: "ready",
      transcriptionStatus: "ready",
    });
    const renderedBytes = scratch.objects.get(currentClip().outputKey!)!;
    expect(renderedBytes.subarray(4, 8).toString()).toBe("ftyp");
    expect(renderedBytes.equals(clipBytes)).toBe(false);
    expect(scratch.speechRequests).toHaveLength(1);
    const poll = await fetch(`${appOrigin}/api/app/clips/${clip.id}`);
    const publicResult = await poll.json();
    expect(publicResult).toMatchObject({
      status: "ready",
      transcriptionStatus: "ready",
      captions: currentClip().captions,
    });
    expect(JSON.stringify(publicResult)).not.toMatch(
      /outputKey|transcriptionRequestStarted|transcriptionVersion|renderVersion|private-media/
    );
    expect(
      (await transcribeClip(user, clip.id, { confirmed: true }))
        .transcriptionStatus
    ).toBe("ready");
    expect(scratch.speechRequests).toHaveLength(1);
  }, 30_000);
  it("never synthesizes captions for a valid no-speech response", async () => {
    scratch.segments = [];
    await transcribeClip(user, clip.id, { confirmed: true });
    await runMediaJob(job(), AbortSignal.timeout(30_000));
    expect(currentClip().captions).toEqual([]);
    expect(currentClip().transcriptionStatus).toBe("ready");
  }, 30_000);
  it("rechecks creator clipping ACL in the worker before sending any paid audio", async () => {
    await transcribeClip(user, clip.id, { confirmed: true });
    scratch.records.set(`source:${source.id}`, {
      ...source,
      allowClip: "creator",
    });
    await expect(
      runMediaJob(job(), AbortSignal.timeout(30_000))
    ).rejects.toMatchObject({ status: 403 });
    expect(scratch.speechRequests).toHaveLength(0);
    expect(scratch.gets).toHaveLength(0);
  });
  it("does not apply a transcript if creator access changes during speech processing", async () => {
    scratch.removeAccessAtSpeech = true;
    await transcribeClip(user, clip.id, { confirmed: true });
    await expect(
      runMediaJob(job(), AbortSignal.timeout(30_000))
    ).rejects.toMatchObject({ status: 403 });
    expect(currentClip().captions).toEqual([]);
    expect(currentClip().renderVersion).toBe(1);
    expect(scratch.speechRequests).toHaveLength(1);
  }, 30_000);
  it("does not automatically repeat an uncertain paid request after failure or restart, and cleans its temporary directory", async () => {
    scratch.speechStatus = 503;
    await transcribeClip(user, clip.id, { confirmed: true });
    const beforeDirectories = (await readdir(tmpdir())).filter(name =>
      name.startsWith("respawn-media-")
    );
    await expect(
      runMediaJob(job(), AbortSignal.timeout(30_000))
    ).rejects.toMatchObject({ status: 422 });
    expect(currentClip().captions).toEqual([]);
    expect(scratch.speechRequests).toHaveLength(1);
    await expect(
      runMediaJob({ ...job(), attempts: 2 }, AbortSignal.timeout(30_000))
    ).rejects.toThrow("interrupted");
    expect(scratch.speechRequests).toHaveLength(1);
    expect(
      (await readdir(tmpdir())).filter(name =>
        name.startsWith("respawn-media-")
      )
    ).toEqual(beforeDirectories);
    // Emulate the durable executor's terminal-error transition, then obtain renewed consent.
    scratch.records.set(`clip:${clip.id}`, {
      ...currentClip(),
      transcriptionStatus: "error",
    });
    scratch.speechStatus = 200;
    await transcribeClip(user, clip.id, { confirmed: true });
    expect(currentClip().transcriptionVersion).toBe(2);
    expect(
      scratch.records.get(`mediaJob:job:clip-transcribe:${clip.id}:2`)
    ).toMatchObject({ version: 2 });
    await runMediaJob({ ...job(), version: 2 }, AbortSignal.timeout(30_000));
    expect(scratch.speechRequests).toHaveLength(2);
    expect(currentClip().transcriptionStatus).toBe("ready");
  }, 30_000);
  it("ignores stale or undone queued jobs without calling speech", async () => {
    await transcribeClip(user, clip.id, { confirmed: true });
    await runMediaJob({ ...job(), version: 99 }, AbortSignal.timeout(30_000));
    scratch.records.set(`clip:${clip.id}`, {
      ...currentClip(),
      deletedAt: new Date().toISOString(),
    });
    await runMediaJob(job(), AbortSignal.timeout(30_000));
    expect(scratch.speechRequests).toHaveLength(0);
  });
  it("rejects a clip duration over 60 seconds before any paid request", async () => {
    scratch.records.set(`clip:${clip.id}`, { ...clip, end: 61.5 });
    await expect(
      transcribeClip(user, clip.id, { confirmed: true })
    ).rejects.toMatchObject({ status: 422 });
    expect(scratch.speechRequests).toHaveLength(0);
  });
});
