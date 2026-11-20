import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express, { type Request } from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  defaultProfile,
  PROFILE_MODULES,
  type ProfileInput,
} from "../shared/profile-types";
import {
  defaultProfileWorld,
  WORLD_LIMITS,
  WORLD_MODULES,
} from "../shared/profile-world-types";

// The real SDK, DB, signer and storage are NEVER invoked, including in actual codec tests.
const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  objects: new Map<string, Buffer>(),
  locks: new Map<string, Promise<void>>(),
  creates: vi.fn(),
  puts: vi.fn(),
  signs: vi.fn(),
  mutates: vi.fn(),
  upstream: "",
  mode: "normal",
  ticketIdentity: 1,
  readHook: undefined as undefined | (() => void),
  getHook: undefined as undefined | ((key: string) => void),
  putGate: undefined as undefined | Promise<void>,
  signGate: undefined as undefined | Promise<string>,
  failPut: false,
  failCreate: false,
}));
vi.mock("./features/store", () => ({
  get: async (kind: string, id: string) => {
    const key = `${kind}/${id}`;
    fake.getHook?.(key);
    return structuredClone(fake.records.get(key));
  },
  list: async (kind: string) =>
    [...fake.records.entries()]
      .filter(([key]) => key.startsWith(kind + "/"))
      .map(([, value]) => structuredClone(value)),
  create: async (kind: string, _owner: number, data: { id: string }) => {
    fake.creates(kind, data);
    if (fake.failCreate) throw new Error("Isolated create failure");
    const key = `${kind}/${data.id}`;
    if (fake.records.has(key)) throw new Error("Duplicate isolated record");
    fake.records.set(key, structuredClone(data));
    return structuredClone(data);
  },
  mutate: async (kind: string, id: string, fn: (value: any) => any) => {
    const key = `${kind}/${id}`,
      previous = fake.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    fake.locks.set(
      key,
      previous.then(() => held)
    );
    await previous;
    try {
      fake.mutates(kind, id);
      if (!fake.records.has(key))
        throw Object.assign(new Error("Missing isolated record"), {
          status: 404,
        });
      const next = fn(structuredClone(fake.records.get(key)));
      fake.records.set(key, structuredClone(next));
      return structuredClone(next);
    } finally {
      release();
    }
  },
  database: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            fake.ticketIdentity
              ? [{ id: fake.ticketIdentity, name: "Isolated member" }]
              : [],
        }),
      }),
    }),
  }),
}));
vi.mock("./_core/sdk", () => ({
  sdk: {
    authenticateRequest: async (req: Request) => {
      const id = Number(req.get("authorization")?.replace("Bearer ", ""));
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error("No isolated session");
      return { id, name: `Test member ${id}` };
    },
  },
}));
vi.mock("./storage", () => ({
  storagePut: async (key: string, bytes: Buffer, mime: string) => {
    fake.puts(key, bytes, mime);
    if (fake.putGate) await fake.putGate;
    if (fake.failPut) throw new Error("SECRET storage failure");
    const privateKey = `SECRET/${key}`;
    fake.objects.set(privateKey, Buffer.from(bytes));
    return {
      key: privateKey,
      url: `https://private.invalid/${privateKey}?signed=SECRET`,
    };
  },
  storageGetSignedUrl: async (key: string) => {
    fake.signs(key);
    return (
      fake.signGate ?? `${fake.upstream}/objects/${encodeURIComponent(key)}`
    );
  },
}));
import { registerProfileRoutes } from "./features/profiles";
import { mediaTicket } from "./features/access";
import { command } from "./features/processing";
import { processWorldAudio } from "./features/profile-world-media";

let server: Server,
  remote: Server,
  origin = "",
  directory = "";
let png: Buffer,
  wav: Buffer,
  mp3: Buffer,
  m4a: Buffer,
  ogg: Buffer,
  opus: Buffer,
  movie: Buffer,
  flac: Buffer;
const base = (instance: Server) =>
  `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
function makeWav(seconds = 1, rate = 8000) {
  const frames = Math.round(seconds * rate),
    data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++)
    data.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 1200),
      44 + i * 2
    );
  return data;
}
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerProfileRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  origin = base(server);
  const storage = express();
  storage.get("/objects/:key", (req, res) => {
    fake.readHook?.();
    if (fake.mode === "redirect") {
      res.redirect("https://never-follow.invalid/SECRET");
      return;
    }
    if (fake.mode === "stall") return;
    if (fake.mode === "huge") {
      res.set("Content-Length", String(WORLD_LIMITS.audioBytes + 1)).end();
      return;
    }
    if (fake.mode === "overrun") {
      res.write(Buffer.alloc(WORLD_LIMITS.audioBytes + 1));
      res.end();
      return;
    }
    const bytes = fake.objects.get(req.params.key);
    if (!bytes) {
      res.status(404).end();
      return;
    }
    if (fake.mode === "truncated") {
      res.end(bytes.subarray(0, bytes.length - 1));
      return;
    }
    if (fake.mode === "wrongmagic") {
      res.send(Buffer.alloc(bytes.length));
      return;
    }
    if (fake.mode === "encoded") res.set("Content-Encoding", "gzip");
    if (fake.mode === "streamstall") {
      res.write(bytes.subarray(0, 4));
      return;
    }
    res
      .type(req.params.key.endsWith(".mp3") ? "audio/mpeg" : "image/webp")
      .send(bytes);
  });
  remote = storage.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => remote.once("listening", resolve));
  fake.upstream = base(remote);
  png = await sharp({
    create: { width: 80, height: 40, channels: 3, background: "#369" },
  })
    .png()
    .withMetadata()
    .toBuffer();
  directory = await mkdtemp(path.join(tmpdir(), "respawn-world-test-"));
  wav = makeWav();
  await writeFile(path.join(directory, "source.wav"), wav);
  for (const [name, args] of [
    ["mp3", ["-c:a", "libmp3lame", "-b:a", "192k"]],
    ["m4a", ["-c:a", "aac"]],
    ["ogg", ["-c:a", "libvorbis"]],
    ["opus", ["-c:a", "libopus", "-f", "ogg"]],
    ["flac", ["-c:a", "flac"]],
  ] as const) {
    await command(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        path.join(directory, "source.wav"),
        "-threads",
        "2",
        "-metadata",
        "title=SECRET SONG TITLE",
        "-metadata",
        "artist=SECRET ARTIST",
        ...args,
        path.join(directory, `source.${name}`),
      ],
      undefined,
      10_000
    );
  }
  mp3 = await readFile(path.join(directory, "source.mp3"));
  m4a = await readFile(path.join(directory, "source.m4a"));
  ogg = await readFile(path.join(directory, "source.ogg"));
  opus = await readFile(path.join(directory, "source.opus"));
  flac = await readFile(path.join(directory, "source.flac"));
  await command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=size=16x16:rate=2",
      "-i",
      path.join(directory, "source.wav"),
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-c:a",
      "aac",
      path.join(directory, "movie.mp4"),
    ],
    undefined,
    10_000
  );
  movie = await readFile(path.join(directory, "movie.mp4"));
}, 60_000);
afterAll(async () => {
  for (const instance of [server, remote]) {
    await new Promise<void>((resolve, reject) => {
      instance.close(error => (error ? reject(error) : resolve()));
      instance.closeAllConnections();
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  fake.records.clear();
  fake.objects.clear();
  fake.locks.clear();
  fake.creates.mockClear();
  fake.puts.mockClear();
  fake.signs.mockClear();
  fake.mutates.mockClear();
  fake.mode = "normal";
  fake.ticketIdentity = 1;
  fake.getHook = undefined;
  fake.readHook = undefined;
  fake.putGate = undefined;
  fake.signGate = undefined;
  fake.failPut = false;
  fake.failCreate = false;
  vi.stubEnv("MANUS_JWT_SECRET", "world-test-only-secret");
  vi.stubEnv("MANUS_PROJECT_ID", "world-test-only-project");
});
function input(): ProfileInput {
  const {
    ownerId: _ownerId,
    media: _media,
    worldMedia: _worldMedia,
    saved: _saved,
    ...fields
  } = defaultProfile(1, "Real member");
  return fields;
}
function seed(
  ownerId = 1,
  visibility: "public" | "members" | "private" = "public",
  extra: any = {}
) {
  const {
    media: _media,
    worldMedia: _worldMedia,
    ...fields
  } = defaultProfile(ownerId, `Member ${ownerId}`);
  const profile = {
    ...fields,
    ...extra,
    id: `profile:${ownerId}`,
    saved: true,
  };
  profile.settings.visibility = visibility;
  fake.records.set(`profile/profile:${ownerId}`, profile);
  return profile;
}
function request(
  url: string,
  user?: number,
  method = "GET",
  body?: unknown,
  originHeader = origin,
  headers: Record<string, string> = {}
) {
  return fetch(origin + url, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${user}` } : {}),
      ...(method !== "GET"
        ? { Origin: originHeader, "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function save(fields: any = input(), user: number | undefined = 1) {
  return request("/api/app/profile/me", user, "PATCH", {
    ...fields,
    confirmed: true,
  });
}
function form(
  bytes = png,
  slot = "art",
  mime = "image/png",
  rights: string | undefined = undefined,
  fileFirst = false
) {
  const body = new FormData();
  const file = () =>
    body.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      "untrusted-name"
    );
  if (fileFirst) file();
  body.append("slot", slot);
  body.append("confirmed", "true");
  if (rights !== undefined) body.append("rightsConfirmed", rights);
  if (!fileFirst) file();
  return body;
}
function upload(
  body = form(),
  user: number | undefined = 1,
  originHeader = origin
) {
  return fetch(origin + "/api/app/profile/world/media", {
    method: "POST",
    headers: {
      Origin: originHeader,
      ...(user ? { Authorization: `Bearer ${user}` } : {}),
    },
    body,
  });
}
async function image(user = 1) {
  const response = await upload(form(), user);
  expect(response.status).toBe(201);
  return response.json();
}
async function audio(bytes = wav, mime = "audio/wav", user = 1) {
  const response = await upload(form(bytes, "music", mime, "true"), user);
  expect(response.status).toBe(201);
  return response.json();
}
function raw(id: string) {
  return fake.records.get(`profile-world-media/${id}`);
}
async function publish(
  asset: any,
  visibility: "public" | "members" | "private" = "public"
) {
  const fields = input();
  fields.settings.visibility = visibility;
  if (asset.kind === "audio")
    fields.world.music = [
      { title: "Owned music", artist: "Member", mediaId: asset.id },
    ];
  else
    fields.world.art = [
      { title: "Owned art", caption: "Caption", mediaId: asset.id },
    ];
  expect((await save(fields)).status).toBe(200);
  return fields;
}
async function scratches() {
  return (await readdir(tmpdir()))
    .filter(name => /^respawn-world-(?!test-)/.test(name))
    .sort();
}

describe("backward-compatible world profile lifecycle", () => {
  it("returns real defaults on unsaved and legacy GETs without writes or changing the five old sections", async () => {
    expect(await (await request("/api/app/profile/me", 1)).json()).toEqual(
      defaultProfile(1, "Test member 1")
    );
    const legacy = seed();
    delete legacy.world;
    const profile = await (await request("/api/app/profiles/1")).json();
    expect(profile.world).toEqual(defaultProfileWorld());
    expect(profile.worldMedia).toEqual({});
    expect(profile.theme.moduleOrder).toEqual(PROFILE_MODULES);
    expect(PROFILE_MODULES).toEqual([
      "about",
      "links",
      "games",
      "posts",
      "clips",
    ]);
    expect(fake.creates).not.toHaveBeenCalled();
    expect(fake.mutates).not.toHaveBeenCalled();
  });
  it("default-fills first legacy save and preserves a previously configured world when an old client omits world", async () => {
    const fields: any = input();
    delete fields.world;
    expect((await save(fields)).status).toBe(200);
    expect(fake.records.get("profile/profile:1").world).toEqual(
      defaultProfileWorld()
    );
    const configured = input();
    configured.world.quote = "Keep playing";
    configured.world.chrome = "chrome";
    configured.theme.font = "mono";
    configured.theme.moduleOrder = [...PROFILE_MODULES].reverse();
    expect((await save(configured)).status).toBe(200);
    fields.theme = configured.theme;
    fields.bio = "Legacy edit";
    const response = await save(fields);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      world: configured.world,
      theme: configured.theme,
      bio: "Legacy edit",
    });
    expect(fake.records.get("profile/profile:1")).not.toHaveProperty(
      "worldMedia"
    );
  });
  it("preserves the current row-locked world, not an earlier read during a concurrent legacy patch", async () => {
    seed();
    let changed = false;
    fake.getHook = key => {
      if (key === "profile/profile:1" && !changed) {
        changed = true;
        fake.records.get(key).world.quote = "Concurrent newer world";
      }
    };
    const fields: any = input();
    delete fields.world;
    expect((await save(fields)).status).toBe(200);
    expect(fake.records.get("profile/profile:1").world.quote).toBe(
      "Concurrent newer world"
    );
  });
  it("requires session, same origin and confirmed full saves for world changes", async () => {
    expect((await save(input(), 0)).status).toBe(401);
    expect(
      (await request("/api/app/profile/me", 1, "PATCH", input())).status
    ).toBe(400);
    expect(
      (
        await request(
          "/api/app/profile/me",
          1,
          "PATCH",
          { ...input(), confirmed: true },
          "https://evil.invalid"
        )
      ).status
    ).toBe(403);
    expect(fake.creates).not.toHaveBeenCalled();
  });
  const invalid: [string, (p: any) => void][] = [
    [
      "null world",
      p => {
        p.world = null;
      },
    ],
    [
      "partial world",
      p => {
        p.world = { quote: "hi" };
      },
    ],
    [
      "unknown world",
      p => {
        p.world.css = "bad";
      },
    ],
    [
      "DTO spoof",
      p => {
        p.worldMedia = {};
      },
    ],
    [
      "quote 501",
      p => {
        p.world.quote = "a".repeat(501);
      },
    ],
    [
      "author 81",
      p => {
        p.world.quoteAuthor = "a".repeat(81);
      },
    ],
    [
      "tag count",
      p => {
        p.world.favoriteMusic = Array.from(
          { length: 21 },
          (_, i) => `tag ${i}`
        );
      },
    ],
    [
      "tag length",
      p => {
        p.world.favoriteMusic = ["a".repeat(81)];
      },
    ],
    [
      "empty tag",
      p => {
        p.world.favoriteMusic = [" "];
      },
    ],
    [
      "tag duplicates",
      p => {
        p.world.favoriteMusic = ["Jazz", "jazz"];
      },
    ],
    [
      "music count",
      p => {
        p.world.music = Array.from({ length: 4 }, () => ({
          title: "",
          artist: "",
          mediaId: "11111111-1111-4111-8111-111111111111",
        }));
      },
    ],
    [
      "music title",
      p => {
        p.world.music = [
          {
            title: "a".repeat(101),
            artist: "",
            mediaId: "11111111-1111-4111-8111-111111111111",
          },
        ];
      },
    ],
    [
      "music artist",
      p => {
        p.world.music = [
          {
            title: "",
            artist: "a".repeat(101),
            mediaId: "11111111-1111-4111-8111-111111111111",
          },
        ];
      },
    ],
    [
      "remote audio",
      p => {
        p.world.music = [
          { title: "", artist: "", mediaId: "https://evil.invalid/song.mp3" },
        ];
      },
    ],
    [
      "nested music field",
      p => {
        p.world.music = [
          {
            title: "",
            artist: "",
            mediaId: "11111111-1111-4111-8111-111111111111",
            url: "evil",
          },
        ];
      },
    ],
    [
      "art count",
      p => {
        p.world.art = Array.from({ length: 13 }, () => ({
          title: "",
          caption: "",
          mediaId: "11111111-1111-4111-8111-111111111111",
        }));
      },
    ],
    [
      "art title",
      p => {
        p.world.art = [
          {
            title: "a".repeat(101),
            caption: "",
            mediaId: "11111111-1111-4111-8111-111111111111",
          },
        ];
      },
    ],
    [
      "art caption",
      p => {
        p.world.art = [
          {
            title: "",
            caption: "a".repeat(501),
            mediaId: "11111111-1111-4111-8111-111111111111",
          },
        ];
      },
    ],
    [
      "panel count",
      p => {
        p.world.panels = Array.from({ length: 7 }, (_, i) => ({
          id: `${i}`,
          title: "",
          text: "",
          accentColor: "#ffffff",
        }));
      },
    ],
    [
      "panel duplicate",
      p => {
        p.world.panels = [0, 1].map(() => ({
          id: "same",
          title: "",
          text: "",
          accentColor: "#ffffff",
        }));
      },
    ],
    [
      "panel ID length",
      p => {
        p.world.panels = [
          { id: "a".repeat(41), title: "", text: "", accentColor: "#ffffff" },
        ];
      },
    ],
    [
      "panel title",
      p => {
        p.world.panels = [
          { id: "a", title: "a".repeat(81), text: "", accentColor: "#ffffff" },
        ];
      },
    ],
    [
      "panel text",
      p => {
        p.world.panels = [
          {
            id: "a",
            title: "",
            text: "a".repeat(5001),
            accentColor: "#ffffff",
          },
        ];
      },
    ],
    [
      "panel hex",
      p => {
        p.world.panels = [{ id: "a", title: "", text: "", accentColor: "red" }];
      },
    ],
    [
      "people count",
      p => {
        p.world.topPeople = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      },
    ],
    [
      "people duplicate",
      p => {
        p.world.topPeople = [1, 1];
      },
    ],
    [
      "people string",
      p => {
        p.world.topPeople = ["1"];
      },
    ],
    [
      "people zero",
      p => {
        p.world.topPeople = [0];
      },
    ],
    [
      "people unsafe",
      p => {
        p.world.topPeople = [Number.MAX_SAFE_INTEGER + 1];
      },
    ],
    [
      "module bool",
      p => {
        p.world.modules.art = 1;
      },
    ],
    [
      "module unknown",
      p => {
        p.world.modules.script = true;
      },
    ],
    [
      "module omitted",
      p => {
        delete p.world.modules.art;
      },
    ],
    [
      "order count",
      p => {
        p.world.moduleOrder.pop();
      },
    ],
    [
      "order duplicate",
      p => {
        p.world.moduleOrder = ["quote", "quote", "art", "people", "panels"];
      },
    ],
    [
      "chrome enum",
      p => {
        p.world.chrome = "css";
      },
    ],
    [
      "portrait enum",
      p => {
        p.world.portrait = "url";
      },
    ],
    [
      "width enum",
      p => {
        p.world.pageWidth = "anything";
      },
    ],
    [
      "markup",
      p => {
        p.world.quote = "<script>";
      },
    ],
    [
      "control",
      p => {
        p.world.quote = "bad\u0000";
      },
    ],
  ];
  it.each(invalid)(
    "rejects malformed %s without writes",
    async (_name, mutate) => {
      const fields = input();
      mutate(fields);
      expect((await save(fields)).status).toBe(400);
      expect(fake.creates).not.toHaveBeenCalled();
      expect(fake.puts).not.toHaveBeenCalled();
    }
  );
  it("accepts all exact text/control boundaries and keeps the new section list independent", async () => {
    const fields = input();
    fields.world.quote = "q".repeat(500);
    fields.world.quoteAuthor = "a".repeat(80);
    fields.world.favoriteMusic = Array.from({ length: 20 }, (_, i) =>
      `${i}`.padEnd(80, "x")
    );
    fields.world.panels = Array.from({ length: 6 }, (_, i) => ({
      id: `${i}`.padEnd(40, "x"),
      title: "t".repeat(80),
      text: "x".repeat(5000),
      accentColor: "#fF1234",
    }));
    fields.world.chrome = "chrome";
    fields.world.portrait = "square";
    fields.world.pageWidth = "cozy";
    fields.world.moduleOrder = [...WORLD_MODULES].reverse();
    fields.world.modules.art = false;
    const response = await save(fields);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(fields);
  });
  it("accepts exactly three credited tracks, twelve captioned art entries and eight actual people", async () => {
    const art = await image(),
      track = await audio(),
      fields = input();
    fields.world.music = Array.from({ length: 3 }, () => ({
      title: "t".repeat(100),
      artist: "a".repeat(100),
      mediaId: track.id,
    }));
    fields.world.art = Array.from({ length: 12 }, () => ({
      title: "t".repeat(100),
      caption: "c".repeat(500),
      mediaId: art.id,
    }));
    fields.world.topPeople = Array.from({ length: 8 }, (_, i) => i + 2);
    for (const id of fields.world.topPeople) seed(id);
    const response = await save(fields);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.world).toEqual(fields.world);
    expect(Object.keys(body.worldMedia).sort()).toEqual(
      [art.id, track.id].sort()
    );
  });
});

describe("current featured people and safe asset DTOs", () => {
  it("requires actual visible saved profiles at save time", async () => {
    seed(2, "members");
    seed(3, "private");
    seed(4).saved = false;
    const fields = input();
    for (const id of [3, 4, 999]) {
      fields.world.topPeople = [id];
      expect((await save(fields)).status).toBe(400);
    }
    fields.world.topPeople = [2];
    expect((await save(fields)).status).toBe(200);
  });
  it("returns ordered currently visible profiles, skips deleted/private and checks owner privacy", async () => {
    const owner = seed();
    owner.world.topPeople = [4, 2, 3, 5, 6];
    seed(2, "members");
    seed(3, "private");
    seed(4);
    seed(5);
    seed(6).deletedAt = new Date().toISOString();
    fake.records.delete("profile/profile:5");
    const ids = async (user?: number) =>
      (await (await request("/api/app/profiles/1/featured", user)).json()).map(
        (p: any) => p.ownerId
      );
    expect(await ids()).toEqual([4]);
    expect(await ids(9)).toEqual([4, 2]);
    owner.settings.visibility = "private";
    expect((await request("/api/app/profiles/1/featured", 9)).status).toBe(404);
    expect(await ids(1)).toEqual([4, 2]);
    for (const id of ["0", "-1", "foo", "9007199254740993"])
      expect((await request(`/api/app/profiles/${id}/featured`)).status).toBe(
        404
      );
    expect(fake.creates).not.toHaveBeenCalled();
  });
  it("rechecks people and owner privacy while composing featured output", async () => {
    const owner = seed();
    owner.world.topPeople = [2];
    seed(2);
    let reads = 0;
    fake.getHook = key => {
      if (key === "profile/profile:2" && ++reads === 2)
        fake.records.get(key).settings.visibility = "private";
    };
    expect(
      await (await request("/api/app/profiles/1/featured")).json()
    ).toEqual([]);
    fake.getHook = key => {
      if (key === "profile/profile:2") owner.settings.visibility = "private";
    };
    expect((await request("/api/app/profiles/1/featured")).status).toBe(404);
  });
  it("forbids copied assets, wrong kind, missing or invalid assets", async () => {
    const foreign = await image(2),
      own = await image(),
      song = await audio();
    const fields = input();
    for (const id of [
      foreign.id,
      song.id,
      "11111111-1111-4111-8111-111111111111",
    ]) {
      fields.world.art = [{ title: "Art", caption: "", mediaId: id }];
      expect((await save(fields)).status).toBe(400);
    }
    fields.world.art = [];
    fields.world.music = [{ title: "Track", artist: "", mediaId: own.id }];
    expect((await save(fields)).status).toBe(400);
  });
  it("serializes only selected matching own assets with a nested whitelist, not drafts or raw stored DTOs", async () => {
    const selected = await image(),
      draft = await image(),
      foreign = await image(2),
      song = await audio();
    const fields = await publish(selected);
    fields.world.music = [
      { title: "Track", artist: "Artist", mediaId: song.id },
    ];
    expect((await save(fields)).status).toBe(200);
    const profile = fake.records.get("profile/profile:1");
    profile.worldMedia = { secret: { url: "https://private.invalid/SECRET" } };
    profile.world.objectKey = "SECRET";
    profile.world.art[0].objectKey = "SECRET";
    profile.world.music[0].signedUrl = "https://private.invalid/SECRET";
    profile.world.modules.script = "SECRET";
    profile.world.art.push({
      title: "Forged",
      caption: "",
      mediaId: foreign.id,
    });
    const response = await request("/api/app/profiles/1");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body.worldMedia).sort()).toEqual(
      [selected.id, song.id].sort()
    );
    expect(body.worldMedia).not.toHaveProperty(draft.id);
    expect(JSON.stringify(body)).not.toMatch(
      /SECRET|objectKey|signedUrl|private.invalid|script/
    );
  });
  it("checks current privacy and references again before returning profile DTO assets", async () => {
    const asset = await image();
    await publish(asset);
    let reads = 0;
    fake.getHook = key => {
      if (key === `profile-world-media/${asset.id}` && ++reads === 1)
        fake.records.get("profile/profile:1").settings.visibility = "private";
    };
    expect((await request("/api/app/profiles/1")).status).toBe(404);
    fake.records.get("profile/profile:1").settings.visibility = "public";
    fake.getHook = key => {
      if (key === `profile-world-media/${asset.id}`)
        fake.records.get("profile/profile:1").world.art = [];
    };
    expect(
      (await (await request("/api/app/profiles/1")).json()).worldMedia
    ).toEqual({});
  });
});

describe("real native world upload processing", () => {
  it("requires session, same origin, slot and rights acknowledgment before file bytes", async () => {
    expect((await upload(form(), 0)).status).toBe(401);
    expect((await upload(form(), 1, "https://evil.invalid")).status).toBe(403);
    expect((await upload(form(wav, "music", "audio/wav"))).status).toBe(400);
    expect(
      (await upload(form(wav, "music", "audio/wav", "false"))).status
    ).toBe(400);
    expect(
      (await upload(form(wav, "music", "audio/wav", "true", true))).status
    ).toBe(400);
    const late = form(wav, "music", "audio/wav");
    late.append("rightsConfirmed", "true");
    expect((await upload(late)).status).toBe(400);
    const duplicate = form(wav, "music", "audio/wav", "true");
    duplicate.append("slot", "art");
    expect((await upload(duplicate)).status).toBe(400);
    const changed = form();
    changed.append("slot", "music");
    expect((await upload(changed)).status).toBe(400);
    const unconfirmed = form();
    unconfirmed.set("confirmed", "false");
    expect((await upload(unconfirmed)).status).toBe(400);
    expect((await upload(form(png, "script"))).status).toBe(400);
    expect(fake.puts).not.toHaveBeenCalled();
    expect(fake.creates).not.toHaveBeenCalled();
  });
  it.each(["wav", "x-wav", "mp3", "m4a", "x-m4a", "ogg", "opus"])(
    "normalizes real %s to 128kbps audio-only metadata-free MP3",
    async format => {
      const samples: Record<string, [Buffer, string]> = {
        wav: [wav, "audio/wav"],
        "x-wav": [wav, "audio/x-wav"],
        mp3: [mp3, "audio/mpeg"],
        m4a: [m4a, "audio/mp4"],
        "x-m4a": [m4a, "audio/x-m4a"],
        ogg: [ogg, "audio/ogg"],
        opus: [opus, "audio/ogg"],
      };
      const [bytes, mime] = samples[format],
        asset = await audio(bytes, mime),
        record = raw(asset.id);
      expect(asset.kind).toBe("audio");
      expect(asset.duration).toBeGreaterThan(0);
      expect(asset.duration).toBeLessThan(1.5);
      expect(asset).not.toHaveProperty("width");
      expect(asset.url).toMatch(
        /^\/api\/media\/profile-world\/[0-9a-f-]+\?ticket=/
      );
      expect(JSON.stringify(asset)).not.toMatch(
        /SECRET|objectKey|private.invalid/
      );
      const output = path.join(directory, `normalized-${format}.mp3`);
      await writeFile(output, fake.objects.get(record.objectKey)!);
      const probe = JSON.parse(
        await command("ffprobe", [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-show_chapters",
          "-of",
          "json",
          output,
        ])
      );
      expect(probe.streams).toHaveLength(1);
      expect(probe.streams[0]).toMatchObject({
        codec_type: "audio",
        codec_name: "mp3",
        bit_rate: "128000",
        channels: 2,
        sample_rate: "44100",
      });
      expect(probe.chapters).toEqual([]);
      expect(probe.format.tags).toBeUndefined();
      expect(probe.streams[0].tags).toBeUndefined();
      expect(fake.puts.mock.calls[0][0]).toMatch(
        /^private-media\/profile-world\//
      );
    },
    15_000
  );
  it("uses existing native image sanitation and rejects art/audio mismatch", async () => {
    const asset = await image();
    const metadata = await sharp(
      fake.objects.get(raw(asset.id).objectKey)!
    ).metadata();
    expect(asset).toMatchObject({ kind: "image", width: 80, height: 40 });
    expect(metadata.format).toBe("webp");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect((await upload(form(wav, "art", "audio/wav"))).status).toBe(415);
    expect((await upload(form(png, "music", "image/png", "true"))).status).toBe(
      415
    );
  });
  it("rejects playlists, MIME/container mismatches, FLAC and movie streams before any storage writes", async () => {
    for (const [bytes, mime, status] of [
      [
        Buffer.from("#EXTM3U\nhttps://never-fetch.invalid/SECRET"),
        "audio/mpeg",
        415,
      ],
      [
        Buffer.from("[playlist]\nFile1=https://never-fetch.invalid/SECRET"),
        "audio/mp4",
        415,
      ],
      [Buffer.from("not audio"), "audio/wav", 415],
      [wav, "audio/mpeg", 415],
      [mp3, "audio/wav", 415],
      [flac, "audio/flac", 415],
      [flac, "audio/ogg", 415],
      [movie, "audio/mp4", 422],
    ] as const)
      expect((await upload(form(bytes, "music", mime, "true"))).status).toBe(
        status
      );
    expect(fake.puts).not.toHaveBeenCalled();
    expect(fake.signs).not.toHaveBeenCalled();
  });
  it("rejects an actual MP3 with an attached artwork stream rather than treating it as audio-only", async () => {
    const cover = path.join(directory, "cover.png"),
      inputPath = path.join(directory, "covered.mp3");
    await writeFile(cover, png);
    await command(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        path.join(directory, "source.mp3"),
        "-i",
        cover,
        "-map",
        "0:a:0",
        "-map",
        "1:v:0",
        "-c",
        "copy",
        "-id3v2_version",
        "3",
        "-disposition:v",
        "attached_pic",
        inputPath,
      ],
      undefined,
      10_000
    );
    const probe = JSON.parse(
      await command("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        inputPath,
      ])
    );
    expect(
      probe.streams.some((stream: any) => stream.codec_type === "video")
    ).toBe(true);
    expect(
      (
        await upload(
          form(await readFile(inputPath), "music", "audio/mpeg", "true")
        )
      ).status
    ).toBe(422);
    expect(fake.puts).not.toHaveBeenCalled();
  }, 15_000);
  it("rejects corrupt native audio, oversized art/music and actual duration beyond 600 seconds", async () => {
    expect(
      (await upload(form(wav.subarray(0, 44), "music", "audio/wav", "true")))
        .status
    ).toBe(422);
    expect(
      (
        await upload(
          form(
            Buffer.alloc(WORLD_LIMITS.audioBytes + 1),
            "music",
            "audio/wav",
            "true"
          )
        )
      ).status
    ).toBe(413);
    expect(
      (await upload(form(Buffer.alloc(WORLD_LIMITS.imageBytes + 1)))).status
    ).toBe(413);
    expect(
      (await upload(form(makeWav(601), "music", "audio/wav", "true"))).status
    ).toBe(422);
    expect(fake.puts).not.toHaveBeenCalled();
  }, 15_000);
  it("accepts the real 600-second boundary and bounds normalized duration and filesize", async () => {
    const asset = await audio(makeWav(600));
    expect(asset.duration).toBeLessThanOrEqual(600);
    expect(asset.duration).toBeGreaterThan(599.7);
    expect(raw(asset.id).bytes).toBeLessThanOrEqual(WORLD_LIMITS.audioBytes);
  }, 30_000);
  it("cleans bounded upload scratch paths on success, codec failure, storage failure and DB failure", async () => {
    const before = await scratches();
    expect((await upload(form())).status).toBe(201);
    expect(
      (await upload(form(wav.subarray(0, 44), "music", "audio/wav", "true")))
        .status
    ).toBe(422);
    fake.failPut = true;
    expect((await upload(form())).status).toBe(500);
    fake.failPut = false;
    fake.failCreate = true;
    expect((await upload(form())).status).toBe(500);
    fake.failCreate = false;
    await vi.waitFor(async () => expect(await scratches()).toEqual(before));
    expect((await upload(form())).status).toBe(201);
  });
  it("honors an already aborted native processing signal without writes", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      processWorldAudio(
        path.join(directory, "source.wav"),
        directory,
        "audio/wav",
        controller.signal
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(fake.puts).not.toHaveBeenCalled();
  });
  it("cleans actual abandoned multipart streams and releases the owner for another upload", async () => {
    const before = await scratches(),
      boundary = "world-test-abort-boundary";
    const partial =
      `--${boundary}\r\nContent-Disposition: form-data; name="slot"\r\n\r\nart\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="confirmed"\r\n\r\ntrue\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n`;
    const pending = httpRequest(origin + "/api/app/profile/world/media", {
      method: "POST",
      headers: {
        Origin: origin,
        Authorization: "Bearer 1",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": "1000000",
      },
    });
    pending.on("error", () => {});
    pending.write(partial);
    pending.write(png.subarray(0, 20));
    try {
      await vi.waitFor(async () =>
        expect((await scratches()).length).toBeGreaterThan(before.length)
      );
    } finally {
      pending.destroy();
    }
    await vi.waitFor(async () => expect(await scratches()).toEqual(before));
    expect(fake.puts).not.toHaveBeenCalled();
    expect(fake.creates).not.toHaveBeenCalled();
    expect((await upload(form())).status).toBe(201);
  });
  it("bounds concurrent uploads to two total and one per owner, releasing them afterward", async () => {
    let release!: () => void;
    fake.putGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const before = await scratches(),
      first = upload(form(), 1),
      second = upload(form(), 2);
    await vi.waitFor(() => expect(fake.puts).toHaveBeenCalledTimes(2));
    try {
      expect((await upload(form(), 1)).status).toBe(429);
      expect((await upload(form(), 3)).status).toBe(429);
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    await vi.waitFor(async () => expect(await scratches()).toEqual(before));
    fake.putGate = undefined;
    expect((await upload(form(), 3)).status).toBe(201);
  });
});

describe("current private storage, tickets, metadata and byte ranges", () => {
  it("keeps drafts owner-only, renews opaque owner metadata with a session but never metadata tickets", async () => {
    const asset = await audio(),
      metadata = `/api/app/profile/world/media/${asset.id}`;
    expect((await request(`/api/media/profile-world/${asset.id}`)).status).toBe(
      404
    );
    expect(
      (await request(`/api/media/profile-world/${asset.id}`, 2)).status
    ).toBe(404);
    expect((await request(asset.url)).status).toBe(200);
    expect(
      (await request(`/api/media/profile-world/${asset.id}`, 1)).status
    ).toBe(200);
    expect((await request(metadata, 1)).status).toBe(200);
    expect((await request(metadata, 2)).status).toBe(404);
    const ticket = new URL(asset.url, origin).searchParams.get("ticket");
    expect((await request(`${metadata}?ticket=${ticket}`)).status).toBe(404);
    expect((await request("/api/app/profiles/1")).status).toBe(404);
    expect(fake.creates).toHaveBeenCalledTimes(1);
  });
  it("publishes only saved references and revokes old assets for other viewers but not the owner", async () => {
    const first = await audio(),
      second = await audio();
    const fields = await publish(first);
    expect((await request(`/api/media/profile-world/${first.id}`)).status).toBe(
      200
    );
    expect(
      (await request(`/api/app/profile/world/media/${first.id}`)).status
    ).toBe(200);
    fields.world.music[0].mediaId = second.id;
    expect((await save(fields)).status).toBe(200);
    expect((await request(`/api/media/profile-world/${first.id}`)).status).toBe(
      404
    );
    expect(
      (await request(`/api/app/profile/world/media/${first.id}`)).status
    ).toBe(404);
    expect((await request(first.url)).status).toBe(200);
    expect(
      (await request(`/api/media/profile-world/${second.id}`)).status
    ).toBe(200);
    fields.world.music = [];
    expect((await save(fields)).status).toBe(200);
    expect(
      (await request(`/api/media/profile-world/${second.id}`, 2)).status
    ).toBe(404);
  });
  it("checks public/members/private permissions using current ACL even with still-valid viewer tickets", async () => {
    const asset = await audio(),
      fields = await publish(asset, "members"),
      resource = `/api/media/profile-world/${asset.id}`;
    expect((await request(resource)).status).toBe(404);
    expect((await request(resource, 2)).status).toBe(200);
    const body = await (await request("/api/app/profiles/1", 2)).json(),
      memberUrl = body.worldMedia[asset.id].url;
    fake.ticketIdentity = 2;
    expect((await request(memberUrl)).status).toBe(200);
    expect(
      (await request(`/api/app/profile/world/media/${asset.id}`, 2)).status
    ).toBe(200);
    fields.settings.visibility = "private";
    expect((await save(fields)).status).toBe(200);
    expect((await request(memberUrl)).status).toBe(404);
    expect((await request(resource, 2)).status).toBe(404);
    expect(
      (await request(`/api/app/profile/world/media/${asset.id}`, 2)).status
    ).toBe(404);
    expect((await request(resource, 1)).status).toBe(200);
    fields.settings.visibility = "public";
    expect((await save(fields)).status).toBe(200);
    expect((await request(resource)).status).toBe(200);
    fake.records.delete("profile/profile:1");
    expect((await request(resource)).status).toBe(404);
  });
  it("binds tickets to exact resource/project/expiry/current member and never substitutes them for another session", async () => {
    const asset = await audio(),
      other = await image(),
      token = new URL(asset.url, origin).searchParams.get("ticket");
    expect(
      (await request(`/api/media/profile-world/${other.id}?ticket=${token}`))
        .status
    ).toBe(404);
    expect(
      (await request(`/api/media/profile/${asset.id}?ticket=${token}`)).status
    ).toBe(404);
    expect((await request(asset.url + "tampered")).status).toBe(404);
    expect((await request(asset.url, 2)).status).toBe(404);
    vi.stubEnv("MANUS_PROJECT_ID", "different-project");
    expect((await request(asset.url)).status).toBe(404);
    vi.stubEnv("MANUS_PROJECT_ID", "world-test-only-project");
    fake.ticketIdentity = 0;
    expect((await request(asset.url)).status).toBe(404);
    fake.ticketIdentity = 1;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now - 6 * 60_000);
    const expired = mediaTicket(`profile-world/${asset.id}`, 1);
    vi.restoreAllMocks();
    expect(
      (await request(`/api/media/profile-world/${asset.id}?ticket=${expired}`))
        .status
    ).toBe(404);
  });
  it("delivers bounded full and single/suffix/open audio ranges with private no-store headers", async () => {
    const asset = await audio();
    await publish(asset);
    const record = raw(asset.id),
      resource = `/api/media/profile-world/${asset.id}`,
      bytes = fake.objects.get(record.objectKey)!;
    const full = await request(resource);
    expect(full.status).toBe(200);
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
    expect(full.headers.get("content-type")).toContain("audio/mpeg");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("cache-control")).toContain("no-store");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("referrer-policy")).toBe("no-referrer");
    for (const [range, start, end] of [
      ["bytes=4-15", 4, 15],
      ["bytes=-7", bytes.length - 7, bytes.length - 1],
      ["bytes=5-", 5, bytes.length - 1],
      ["bytes=0-999999", 0, bytes.length - 1],
    ] as const) {
      const response = await request(
        resource,
        undefined,
        "GET",
        undefined,
        origin,
        { Range: range }
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(
        `bytes ${start}-${end}/${bytes.length}`
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        bytes.subarray(start, end + 1)
      );
    }
    const signs = fake.signs.mock.calls.length;
    for (const range of [
      "bytes=999999999-",
      "bytes=20-10",
      "bytes=-0",
      "bytes=0-1,5-6",
      "bytes=9007199254740993-",
      "items=0-1",
      "bytes=-",
      "bytes=0-9007199254740993",
    ]) {
      const response = await request(
        resource,
        undefined,
        "GET",
        undefined,
        origin,
        { Range: range }
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(
        `bytes */${bytes.length}`
      );
    }
    expect(fake.signs).toHaveBeenCalledTimes(signs);
  });
  it.each([
    "redirect",
    "huge",
    "overrun",
    "truncated",
    "wrongmagic",
    "encoded",
  ])(
    "refuses %s storage responses without exposing private keys or URLs",
    async mode => {
      const asset = await audio();
      await publish(asset);
      fake.mode = mode;
      const response = await request(`/api/media/profile-world/${asset.id}`);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toMatch(
        /SECRET|private.invalid|never-follow/
      );
    }
  );
  it.each(["signing", "fetch", "stream"])(
    "bounds stalled %s within the 10-second signing/fetch/stream deadline",
    async mode => {
      const asset = await audio();
      await publish(asset);
      if (mode === "signing") fake.signGate = new Promise<string>(() => {});
      else fake.mode = mode === "stream" ? "streamstall" : "stall";
      const started = Date.now(),
        response = await request(`/api/media/profile-world/${asset.id}`);
      expect(response.status).toBe(504);
      expect(Date.now() - started).toBeLessThan(12000);
      expect(await response.text()).not.toContain("SECRET");
    },
    15_000
  );
  it("rechecks current references, visibility and exact asset record after retrieval before output", async () => {
    const asset = await audio();
    await publish(asset);
    const profile = fake.records.get("profile/profile:1"),
      resource = `/api/media/profile-world/${asset.id}`;
    fake.readHook = () => {
      profile.settings.visibility = "private";
    };
    expect((await request(resource)).status).toBe(404);
    profile.settings.visibility = "public";
    fake.readHook = () => {
      profile.world.music = [];
    };
    expect((await request(resource)).status).toBe(404);
    profile.world.music = [{ title: "", artist: "", mediaId: asset.id }];
    fake.readHook = () => {
      raw(asset.id).objectKey = "SECRET/changed";
    };
    expect((await request(resource)).status).toBe(404);
  });
  it("rechecks metadata ACL between record reads and never signs metadata requests", async () => {
    const asset = await audio();
    await publish(asset);
    let reads = 0;
    fake.getHook = key => {
      if (key === `profile-world-media/${asset.id}` && ++reads === 2)
        fake.records.get("profile/profile:1").settings.visibility = "private";
    };
    expect(
      (await request(`/api/app/profile/world/media/${asset.id}`)).status
    ).toBe(404);
    expect(fake.signs).not.toHaveBeenCalled();
  });
  it("rejects unknown/malformed/deleted media records before any storage signing", async () => {
    expect((await request("/api/media/profile-world/nope")).status).toBe(404);
    const asset = await audio();
    await publish(asset);
    const original = structuredClone(raw(asset.id));
    for (const changes of [
      { bytes: WORLD_LIMITS.audioBytes + 1 },
      { duration: 600.1 },
      { deletedAt: new Date().toISOString() },
      { ownerId: 0 },
      { kind: "video", slot: "art", width: 80, height: 40 },
      { id: "11111111-1111-4111-8111-111111111111" },
    ]) {
      fake.records.set(`profile-world-media/${asset.id}`, {
        ...original,
        ...changes,
      });
      expect(
        (await request(`/api/media/profile-world/${asset.id}`)).status
      ).toBe(404);
    }
    expect(fake.signs).not.toHaveBeenCalled();
  });
});
