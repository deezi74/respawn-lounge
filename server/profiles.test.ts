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
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  defaultProfile,
  PROFILE_LIMITS,
  type Profile,
  type ProfileInput,
} from "../shared/profile-types";

// Never call a real DB, SDK authentication service, signing service or object store.
const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  objects: new Map<string, Buffer>(),
  locks: new Map<string, Promise<void>>(),
  creates: vi.fn(),
  mutates: vi.fn(),
  puts: vi.fn(),
  signs: vi.fn(),
  upstream: "",
  ticketIdentity: 1,
  readHook: undefined as undefined | (() => void),
  putGate: undefined as undefined | Promise<void>,
  mode: "normal",
  signGate: undefined as undefined | Promise<string>,
}));
vi.mock("./features/store", () => ({
  get: async (kind: string, id: string) =>
    structuredClone(fake.records.get(`${kind}/${id}`)),
  list: async (kind: string) =>
    [...fake.records.entries()]
      .filter(([key]) => key.startsWith(kind + "/"))
      .map(([, value]) => structuredClone(value)),
  create: async (kind: string, _owner: number, data: { id: string }) => {
    fake.creates(kind, data);
    const key = `${kind}/${data.id}`;
    if (fake.records.has(key)) throw new Error("Duplicate test record");
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
        throw Object.assign(new Error("Missing record"), { status: 404 });
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
              ? [{ id: fake.ticketIdentity, name: "Ticket member" }]
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
        throw new Error("No test session");
      return { id, name: `Test member ${id}` };
    },
  },
}));
vi.mock("./storage", () => ({
  storagePut: async (key: string, data: Buffer, mime: string) => {
    fake.puts(key, data, mime);
    if (fake.putGate) await fake.putGate;
    const secret = `SECRET-KEY/${key}`;
    fake.objects.set(secret, Buffer.from(data));
    return {
      key: secret,
      url: `https://private.invalid/${secret}?signed=NEVER-EXPOSE`,
    };
  },
  storageGetSignedUrl: async (key: string) => {
    fake.signs(key);
    if (fake.signGate) return fake.signGate;
    return `${fake.upstream}/objects/${encodeURIComponent(key)}`;
  },
}));
import { registerProfileRoutes } from "./features/profiles";
import { mediaTicket } from "./features/access";
import { command, probeFile } from "./features/processing";
import {
  sanitizeProfileImage,
  processProfileVideo,
} from "./features/profile-media";

let server: Server,
  remote: Server,
  origin = "",
  directory = "";
let png: Buffer,
  jpeg: Buffer,
  webp: Buffer,
  mp4: Buffer,
  webm: Buffer,
  longVideo: Buffer;
const base = (instance: Server) =>
  `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
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
      res.redirect("https://never-follow.invalid/secret");
      return;
    }
    if (fake.mode === "stall") return;
    if (fake.mode === "huge") {
      res.set("Content-Length", String(PROFILE_LIMITS.videoBytes + 1)).end();
      return;
    }
    if (fake.mode === "overrun") {
      res.write(Buffer.alloc(4096));
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
    res
      .type(req.params.key.endsWith(".mp4") ? "video/mp4" : "image/webp")
      .send(bytes);
  });
  remote = storage.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => remote.once("listening", resolve));
  fake.upstream = base(remote);
  png = await sharp({
    create: { width: 80, height: 40, channels: 3, background: "#36c" },
  })
    .png()
    .toBuffer();
  jpeg = await sharp(png).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  webp = await sharp(png).webp().toBuffer();
  directory = await mkdtemp(path.join(tmpdir(), "respawn-profiles-test-"));
  const input = path.join(directory, "source.mp4");
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
      "testsrc2=size=1600x900:rate=12",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100",
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      input,
    ],
    undefined,
    20_000
  );
  mp4 = await readFile(input);
  const webmPath = path.join(directory, "source.webm");
  await command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      "-i",
      input,
      "-vf",
      "scale=180:320,setsar=1",
      "-c:v",
      "libvpx-vp9",
      "-threads",
      "2",
      "-deadline",
      "realtime",
      "-an",
      webmPath,
    ],
    undefined,
    20_000
  );
  webm = await readFile(webmPath);
  const longPath = path.join(directory, "too-long.mp4");
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
      "color=size=16x16:rate=1",
      "-t",
      "31",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      longPath,
    ],
    undefined,
    20_000
  );
  longVideo = await readFile(longPath);
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
  fake.mutates.mockClear();
  fake.puts.mockClear();
  fake.signs.mockClear();
  fake.mode = "normal";
  fake.readHook = undefined;
  fake.putGate = undefined;
  fake.signGate = undefined;
  fake.ticketIdentity = 1;
  vi.stubEnv("MANUS_JWT_SECRET", "profile-test-only-secret");
  vi.stubEnv("MANUS_PROJECT_ID", "profile-test-only-project");
});
function input(): ProfileInput {
  const {
    ownerId: _ownerId,
    media: _media,
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
  const profile = {
    ...defaultProfile(ownerId, `Member ${ownerId}`),
    ...extra,
    id: `profile:${ownerId}`,
    saved: true,
  };
  delete (profile as any).media;
  profile.settings.visibility = visibility;
  fake.records.set(`profile/profile:${ownerId}`, profile);
  return profile;
}
async function request(
  url: string,
  user?: number,
  method = "GET",
  body?: unknown,
  originHeader = origin
) {
  return fetch(origin + url, {
    method,
    headers: {
      ...(user ? { Authorization: `Bearer ${user}` } : {}),
      ...(method !== "GET"
        ? { Origin: originHeader, "Content-Type": "application/json" }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function save(fields = input(), user: number | undefined = 1) {
  return request("/api/app/profile/me", user, "PATCH", {
    ...fields,
    confirmed: true,
  });
}
function form(
  bytes = png,
  slot = "avatar",
  mime = "image/png",
  confirmed = "true",
  fileFirst = false
) {
  const body = new FormData();
  if (fileFirst)
    body.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      "untrusted-name"
    );
  body.append("slot", slot);
  body.append("confirmed", confirmed);
  if (!fileFirst)
    body.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: mime }),
      "untrusted-name"
    );
  return body;
}
async function upload(
  body = form(),
  user: number | undefined = 1,
  originHeader = origin
) {
  return fetch(origin + "/api/app/profile/media", {
    method: "POST",
    headers: {
      Origin: originHeader,
      ...(user ? { Authorization: `Bearer ${user}` } : {}),
    },
    body,
  });
}
async function image(slot = "avatar", user = 1) {
  const response = await upload(form(png, slot), user);
  expect(response.status).toBe(201);
  return response.json();
}
function rawAsset(id: string) {
  return fake.records.get(`profile-media/${id}`);
}
async function publishAsset(
  asset: any,
  visibility: "public" | "members" | "private" = "public"
) {
  const fields = input();
  fields[`${rawAsset(asset.id).slot}MediaId` as "avatarMediaId"] = asset.id;
  fields.settings.visibility = visibility;
  if (asset.kind === "video") fields.theme.backgroundMode = "video";
  expect((await save(fields)).status).toBe(200);
  return fields;
}

describe("profile HTTP lifecycle and directory", () => {
  it("requires authentication for my profile and performs no writes on any GET", async () => {
    expect((await request("/api/app/profile/me")).status).toBe(401);
    const response = await request("/api/app/profile/me", 1);
    expect(await response.json()).toEqual(defaultProfile(1, "Test member 1"));
    expect(await (await request("/api/app/profiles")).json()).toEqual([]);
    expect((await request("/api/app/profiles/1", 1)).status).toBe(404);
    expect(fake.creates).not.toHaveBeenCalled();
    expect(fake.mutates).not.toHaveBeenCalled();
  });
  it("persists only explicitly confirmed full profile saves with deterministic owner ids", async () => {
    const fields = input();
    fields.displayName = "  Actual gamer  ";
    fields.status = "Looking for a squad";
    fields.statusEmoji = "✅";
    const response = await save(fields);
    expect(response.status).toBe(200);
    const profile = await response.json();
    expect(profile).toMatchObject({
      displayName: "Actual gamer",
      saved: true,
      ownerId: 1,
      media: {},
    });
    expect(fake.records.get("profile/profile:1")).toMatchObject({
      id: "profile:1",
      displayName: "Actual gamer",
      saved: true,
    });
    expect(fake.records.get("profile/profile:1")).not.toHaveProperty("media");
    expect(fake.records.get("profile/profile:1")).not.toHaveProperty(
      "confirmed"
    );
    const createdAt = profile.createdAt;
    fields.headline = "Changed";
    expect((await save(fields)).status).toBe(200);
    expect(
      await (await request("/api/app/profile/me", 1)).json()
    ).toMatchObject({ createdAt, headline: "Changed" });
    expect(
      (
        await request("/api/app/profile/me", undefined, "PATCH", {
          ...fields,
          confirmed: true,
        })
      ).status
    ).toBe(401);
    expect(
      (await request("/api/app/profile/me", 1, "PATCH", fields)).status
    ).toBe(400);
    expect(
      (
        await request("/api/app/profile/me", 1, "PATCH", {
          ...fields,
          confirmed: "true",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request(
          "/api/app/profile/me",
          1,
          "PATCH",
          { ...fields, confirmed: true },
          "https://evil.invalid"
        )
      ).status
    ).toBe(403);
  });
  it("handles concurrent first saves without duplicate people or lost profile identity", async () => {
    const first = input(),
      second = input();
    first.headline = "one";
    second.headline = "two";
    const responses = await Promise.all([save(first), save(second)]);
    expect(responses.map(res => res.status)).toEqual([200, 200]);
    expect([...fake.records.keys()]).toEqual(["profile/profile:1"]);
    expect(fake.records.get("profile/profile:1").ownerId).toBe(1);
  });
  it("uses saved/current public, members and private checks, not discoverability for direct profiles", async () => {
    seed(1, "public");
    seed(2, "members");
    seed(3, "private");
    expect((await request("/api/app/profiles/1")).status).toBe(200);
    expect((await request("/api/app/profiles/2")).status).toBe(404);
    expect((await request("/api/app/profiles/2", 4)).status).toBe(200);
    expect((await request("/api/app/profiles/3", 4)).status).toBe(404);
    expect((await request("/api/app/profiles/3", 3)).status).toBe(200);
    fake.records.get("profile/profile:1").settings.discoverable = false;
    expect((await request("/api/app/profiles/1")).status).toBe(200);
    fake.records.get("profile/profile:1").settings.visibility = "private";
    expect((await request("/api/app/profiles/1")).status).toBe(404);
    for (const id of ["0", "-1", "foo", "1.5", "9007199254740993"])
      expect((await request(`/api/app/profiles/${id}`)).status).toBe(404);
  });
  it("lists only real saved discoverable visible nonprivate members, supports search and roles, caps 60", async () => {
    seed(1, "public", {
      displayName: "Real streamer",
      roles: ["streamer"],
      games: ["Apex"],
    });
    seed(2, "members");
    seed(3, "private");
    seed(4).settings.discoverable = false;
    seed(5).saved = false;
    expect(
      (await (await request("/api/app/profiles")).json()).map(
        (p: Profile) => p.ownerId
      )
    ).toEqual([1]);
    expect(
      (await (await request("/api/app/profiles", 3)).json())
        .map((p: Profile) => p.ownerId)
        .sort()
    ).toEqual([1, 2]);
    expect(
      await (
        await request("/api/app/profiles?search=APEX&role=streamer")
      ).json()
    ).toHaveLength(1);
    expect(
      await (await request("/api/app/profiles?search=missing")).json()
    ).toEqual([]);
    expect((await request("/api/app/profiles?role=admin")).status).toBe(400);
    expect((await request("/api/app/profiles?search=a&search=b")).status).toBe(
      400
    );
    for (let id = 6; id < 80; id++) seed(id);
    expect(await (await request("/api/app/profiles")).json()).toHaveLength(60);
    expect(fake.creates).not.toHaveBeenCalled();
  });
  it("serializes an explicit nested whitelist, never stored keys, arbitrary metadata or object URLs", async () => {
    const profile = seed();
    profile.objectKey = "SECRET";
    profile.signedUrl = "https://never.invalid";
    profile.theme.backgroundUrl = "https://never.invalid/bg";
    profile.theme.modules.script = "bad";
    profile.settings.secret = "SECRET";
    profile.links = [
      {
        label: "Channel",
        url: "https://example.com/channel",
        objectKey: "SECRET",
      },
    ];
    const response = await request("/api/app/profiles/1");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("SECRET");
    expect(body).not.toContain("never.invalid");
    expect(body).not.toContain("script");
  });
});

describe("strict complete ProfileInput validation", () => {
  const invalid: [string, (fields: any) => void][] = [
    [
      "unknown top-level field",
      p => {
        p.script = "alert(1)";
      },
    ],
    [
      "owner spoof",
      p => {
        p.ownerId = 2;
      },
    ],
    [
      "media spoof",
      p => {
        p.media = {};
      },
    ],
    [
      "empty name",
      p => {
        p.displayName = "  ";
      },
    ],
    [
      "long name",
      p => {
        p.displayName = "x".repeat(81);
      },
    ],
    [
      "bio too long",
      p => {
        p.bio = "x".repeat(5001);
      },
    ],
    [
      "control character",
      p => {
        p.headline = "hi\u0000";
      },
    ],
    [
      "markup",
      p => {
        p.bio = "<script>bad</script>";
      },
    ],
    [
      "status too long",
      p => {
        p.status = "x".repeat(121);
      },
    ],
    [
      "invalid status emoji",
      p => {
        p.statusEmoji = "javascript:alert(1)";
      },
    ],
    [
      "avatar emoji enum",
      p => {
        p.avatarEmoji = "admin";
      },
    ],
    [
      "role enum",
      p => {
        p.roles = ["admin"];
      },
    ],
    [
      "roles duplicate",
      p => {
        p.roles = ["gamer", "gamer"];
      },
    ],
    [
      "no role",
      p => {
        p.roles = [];
      },
    ],
    [
      "game count",
      p => {
        p.games = Array.from({ length: 21 }, (_, i) => `game${i}`);
      },
    ],
    [
      "games empty",
      p => {
        p.games = [""];
      },
    ],
    [
      "platform duplicates",
      p => {
        p.platforms = ["PC", "pc"];
      },
    ],
    [
      "link count",
      p => {
        p.links = Array.from({ length: 9 }, () => ({
          label: "site",
          url: "https://example.com",
        }));
      },
    ],
    [
      "script link",
      p => {
        p.links = [{ label: "bad", url: "javascript:alert(1)" }];
      },
    ],
    [
      "data link",
      p => {
        p.links = [{ label: "bad", url: "data:text/html,bad" }];
      },
    ],
    [
      "link credentials",
      p => {
        p.links = [{ label: "bad", url: "https://user:pass@example.com" }];
      },
    ],
    [
      "link unknown field",
      p => {
        p.links = [{ label: "link", url: "https://example.com", html: "bad" }];
      },
    ],
    [
      "raw media URL",
      p => {
        p.avatarMediaId = "https://example.com/avatar.png";
      },
    ],
    [
      "hex only",
      p => {
        p.theme.accentColor = "red";
      },
    ],
    [
      "CSS injection",
      p => {
        p.theme.cardColor = "#ffffff;background:url(x)";
      },
    ],
    [
      "external background",
      p => {
        p.theme.backgroundUrl = "https://example.com/a";
      },
    ],
    [
      "unknown theme field",
      p => {
        p.theme.css = "body{}";
      },
    ],
    [
      "opacity range",
      p => {
        p.theme.cardOpacity = 1.1;
      },
    ],
    [
      "opacity lower bound",
      p => {
        p.theme.ghostOpacity = -1;
      },
    ],
    [
      "blur range",
      p => {
        p.theme.backgroundBlur = 25;
      },
    ],
    [
      "numeric types",
      p => {
        p.theme.overlayOpacity = "0.5";
      },
    ],
    [
      "layout enum",
      p => {
        p.theme.layout = "script";
      },
    ],
    [
      "font enum",
      p => {
        p.theme.font = "url(x)";
      },
    ],
    [
      "background mode enum",
      p => {
        p.theme.backgroundMode = "external";
      },
    ],
    [
      "size enum",
      p => {
        p.theme.backgroundSize = "stretch";
      },
    ],
    [
      "position enum",
      p => {
        p.theme.backgroundPosition = "left";
      },
    ],
    [
      "ghost position enum",
      p => {
        p.theme.ghostPosition = "somewhere";
      },
    ],
    [
      "ghost size enum",
      p => {
        p.theme.ghostSize = "huge";
      },
    ],
    [
      "corners enum",
      p => {
        p.theme.corners = "css";
      },
    ],
    [
      "glow enum",
      p => {
        p.theme.glow = "css";
      },
    ],
    [
      "section duplicate",
      p => {
        p.theme.moduleOrder = ["about", "links", "games", "posts", "posts"];
      },
    ],
    [
      "missing section",
      p => {
        p.theme.moduleOrder.pop();
      },
    ],
    [
      "unknown section",
      p => {
        p.theme.modules.script = true;
      },
    ],
    [
      "section bool",
      p => {
        p.theme.modules.about = 1;
      },
    ],
    [
      "visibility enum",
      p => {
        p.settings.visibility = "everyone";
      },
    ],
    [
      "boolean settings",
      p => {
        p.settings.discoverable = "false";
      },
    ],
    [
      "unknown settings",
      p => {
        p.settings.html = "bad";
      },
    ],
    [
      "missing field",
      p => {
        delete p.theme;
      },
    ],
  ];
  it.each(invalid)("rejects %s without writing", async (_name, mutate) => {
    const fields = input();
    mutate(fields);
    expect((await save(fields)).status).toBe(400);
    expect(fake.creates).not.toHaveBeenCalled();
    expect(fake.puts).not.toHaveBeenCalled();
  });
  it("accepts all structural Myspace controls and legitimate HTTP(S) links", async () => {
    const fields = input();
    fields.theme = {
      ...fields.theme,
      backgroundMode: "solid",
      backgroundBlur: 24,
      ghostOpacity: 0.5,
      ghostPosition: "top-left",
      ghostSize: "large",
      backgroundSize: "tile",
      font: "mono",
      layout: "compact",
      corners: "square",
      glow: "strong",
      moduleOrder: ["clips", "posts", "games", "links", "about"],
    };
    fields.settings = {
      ...fields.settings,
      visibility: "private",
      reducedMotion: true,
      autoplayBackground: true,
    };
    fields.links = [
      { label: "Channel", url: "https://example.com/channel?tab=clips#latest" },
    ];
    const response = await save(fields);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(fields);
  });
});

describe("actual Sharp uploads and media publication boundaries", () => {
  it("requires session, origin, exact multipart confirmation, slot/MIME and field order before file bytes", async () => {
    expect((await upload(form(), 0)).status).toBe(401);
    expect((await upload(form(), 1, "https://evil.invalid")).status).toBe(403);
    expect(
      (await upload(form(png, "avatar", "image/png", "false"))).status
    ).toBe(400);
    expect((await upload(form(png, "script"))).status).toBe(400);
    expect((await upload(form(png, "avatar", "image/svg+xml"))).status).toBe(
      415
    );
    expect(
      (await upload(form(png, "avatar", "image/png", "true", true))).status
    ).toBe(400);
    const duplicate = form();
    duplicate.append("slot", "background");
    expect((await upload(duplicate)).status).toBe(400);
    expect(fake.puts).not.toHaveBeenCalled();
    expect(fake.creates).not.toHaveBeenCalled();
  });
  it("decodes real JPEG/PNG/WebP, honors EXIF rotation and strips metadata", async () => {
    for (const [bytes, mime, width, height] of [
      [png, "image/png", 80, 40],
      [jpeg, "image/jpeg", 40, 80],
      [webp, "image/webp", 80, 40],
    ] as const) {
      const response = await upload(form(bytes, "avatar", mime));
      expect(response.status).toBe(201);
      const asset = await response.json();
      expect(asset).toMatchObject({ kind: "image", width, height });
      expect(asset.url).toMatch(/^\/api\/media\/profile\/[0-9a-f-]+\?ticket=/);
      expect(JSON.stringify(asset)).not.toMatch(
        /SECRET|private.invalid|objectKey|signed/
      );
      const raw = rawAsset(asset.id);
      const meta = await sharp(fake.objects.get(raw.objectKey)!).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
    }
    expect(
      [...fake.records.keys()].every(key => key.startsWith("profile-media/"))
    ).toBe(true);
  });
  it("rejects corrupt, mismatched, animated, oversized and decompression-bomb images without storage writes", async () => {
    expect((await upload(form(Buffer.from("not an image")))).status).toBe(415);
    expect((await upload(form(png, "avatar", "image/jpeg"))).status).toBe(415);
    expect((await upload(form(png.subarray(0, 40)))).status).toBe(422);
    expect(
      (await upload(form(Buffer.alloc(PROFILE_LIMITS.imageBytes + 1)))).status
    ).toBe(413);
    const big = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer();
    expect((await upload(form(big))).status).toBe(422);
    // Real APNG animation control chunk at a valid PNG chunk boundary (even first-frame-only decoders reject it).
    const acTL = Buffer.from([
      0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(
      (
        await upload(
          form(Buffer.concat([png.subarray(0, 33), acTL, png.subarray(33)]))
        )
      ).status
    ).toBe(415);
    expect(fake.puts).not.toHaveBeenCalled();
  });
  it("bounds real native output dimensions, retaining aspect ratio", async () => {
    const wide = await sharp({
      create: { width: 4000, height: 1000, channels: 3, background: "#06f" },
    })
      .png()
      .toBuffer();
    const result = await sanitizeProfileImage(wide, "image/png");
    expect(result).toMatchObject({ width: 2048, height: 512 });
  });
  it("keeps pre-save uploads owner-only, then publishes only explicit references and revokes replacements", async () => {
    const first = await image();
    expect((await request(first.url)).status).toBe(200);
    expect((await request(`/api/media/profile/${first.id}`)).status).toBe(404);
    expect((await request(`/api/media/profile/${first.id}`, 2)).status).toBe(
      404
    );
    expect((await request(`/api/media/profile/${first.id}`, 1)).status).toBe(
      200
    );
    expect((await request("/api/app/profiles/1")).status).toBe(404);
    expect(await (await request("/api/app/profiles")).json()).toEqual([]);
    const fields = await publishAsset(first);
    expect((await request(`/api/media/profile/${first.id}`)).status).toBe(200);
    const profile = await (await request("/api/app/profiles/1")).json();
    expect(profile.media.avatar.url).toBe(`/api/media/profile/${first.id}`);
    const second = await image();
    fields.avatarMediaId = second.id;
    expect((await save(fields)).status).toBe(200);
    expect((await request(`/api/media/profile/${first.id}`)).status).toBe(404);
    expect((await request(first.url)).status).toBe(200); // Revoked public artwork remains the owner's own draft.
    expect((await request(`/api/media/profile/${second.id}`)).status).toBe(200);
    fields.avatarMediaId = null;
    expect((await save(fields)).status).toBe(200);
    expect((await request(`/api/media/profile/${second.id}`)).status).toBe(404);
  });
  it("enforces ownership, original slot and media kind when saving references", async () => {
    const avatar = await image(),
      banner = await image("banner"),
      foreign = await image("avatar", 2);
    const fields = input();
    fields.avatarMediaId = foreign.id;
    expect((await save(fields)).status).toBe(400);
    fields.avatarMediaId = banner.id;
    expect((await save(fields)).status).toBe(400);
    fields.avatarMediaId = avatar.id;
    fields.backgroundMediaId = avatar.id;
    expect((await save(fields)).status).toBe(400);
    fields.backgroundMediaId = null;
    fields.ghostMediaId = "11111111-1111-4111-8111-111111111111";
    expect((await save(fields)).status).toBe(400);
    expect(fake.records.has("profile/profile:1")).toBe(false);
  });
  it("checks current members/private visibility even with still-valid media tickets", async () => {
    const asset = await image();
    const fields = await publishAsset(asset, "members");
    expect((await request(`/api/media/profile/${asset.id}`)).status).toBe(404);
    const profile = await (await request("/api/app/profiles/1", 2)).json();
    const memberUrl = profile.media.avatar.url;
    fake.ticketIdentity = 2;
    expect((await request(memberUrl)).status).toBe(200);
    fields.settings.visibility = "private";
    expect((await save(fields)).status).toBe(200);
    expect((await request(memberUrl)).status).toBe(404);
    expect((await request(`/api/media/profile/${asset.id}`, 2)).status).toBe(
      404
    );
    expect((await request(`/api/media/profile/${asset.id}`, 1)).status).toBe(
      200
    );
    fields.settings.visibility = "public";
    expect((await save(fields)).status).toBe(200);
    expect((await request(`/api/media/profile/${asset.id}`)).status).toBe(200);
  });
  it("binds tickets to exact resource, expiry, project and a currently existing member", async () => {
    const asset = await image(),
      other = await image();
    const ticket = new URL(asset.url, origin).searchParams.get("ticket");
    expect(
      (await request(`/api/media/profile/${other.id}?ticket=${ticket}`)).status
    ).toBe(404);
    expect(
      (await request(`/api/media/profile/${asset.id}/poster?ticket=${ticket}`))
        .status
    ).toBe(404);
    expect((await request(asset.url + "tamper")).status).toBe(404);
    vi.stubEnv("MANUS_PROJECT_ID", "different-project");
    expect((await request(asset.url)).status).toBe(404);
    vi.stubEnv("MANUS_PROJECT_ID", "profile-test-only-project");
    fake.ticketIdentity = 0;
    expect((await request(asset.url)).status).toBe(404);
    fake.ticketIdentity = 1;
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now - 6 * 60_000);
    const expired = mediaTicket(`profile/${asset.id}`, 1);
    vi.restoreAllMocks();
    expect(
      (await request(`/api/media/profile/${asset.id}?ticket=${expired}`)).status
    ).toBe(404);
  });
  it("rechecks ACL/references after storage retrieval, before sending bytes", async () => {
    const asset = await image();
    await publishAsset(asset);
    fake.readHook = () => {
      fake.records.get("profile/profile:1").settings.visibility = "private";
    };
    const response = await request(`/api/media/profile/${asset.id}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
    fake.records.get("profile/profile:1").settings.visibility = "public";
    fake.readHook = () => {
      fake.records.get("profile/profile:1").avatarMediaId = null;
    };
    expect((await request(`/api/media/profile/${asset.id}`)).status).toBe(404);
  });
  it.each(["redirect", "huge", "overrun", "truncated"])(
    "rejects %s upstream responses and sends no private addresses",
    async mode => {
      const asset = await image();
      await publishAsset(asset);
      fake.mode = mode;
      const response = await request(`/api/media/profile/${asset.id}`);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toMatch(
        /SECRET|never-follow|private.invalid/
      );
    }
  );
  it("sets noncacheable/nosniff delivery and checks unknown ids without signing", async () => {
    expect((await request("/api/media/profile/nope")).status).toBe(404);
    expect(fake.signs).not.toHaveBeenCalled();
    const asset = await image();
    const response = await request(asset.url);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toContain("image/webp");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      fake.objects.get(rawAsset(asset.id).objectKey)
    );
  });
  it("bounds concurrency per user before processing any second upload", async () => {
    let release!: () => void;
    fake.putGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = upload();
    await vi.waitFor(() => expect(fake.puts).toHaveBeenCalled());
    try {
      expect((await upload()).status).toBe(429);
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
  });
});

describe("actual FFmpeg profile background processing and delivery", () => {
  it("normalizes MP4 to bounded silent H264/yuv420p with a real WebP poster and Range delivery", async () => {
    expect((await probeFile(path.join(directory, "source.mp4"))).audio).toBe(
      true
    );
    const response = await upload(form(mp4, "background", "video/mp4"));
    expect(response.status).toBe(201);
    const asset = await response.json();
    expect(asset).toMatchObject({ kind: "video", width: 1280, height: 720 });
    expect(asset.duration).toBeCloseTo(1, 1);
    expect(asset.posterUrl).toMatch(/\/poster\?ticket=/);
    const raw = rawAsset(asset.id),
      output = path.join(directory, "normalized.mp4");
    await writeFile(output, fake.objects.get(raw.objectKey)!);
    expect(await probeFile(output)).toMatchObject({
      audio: false,
      width: 1280,
      height: 720,
    });
    const probe = JSON.parse(
      await command("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        output,
      ])
    );
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({
      codec_name: "h264",
      pix_fmt: "yuv420p",
    });
    expect(
      (await sharp(fake.objects.get(raw.posterKey)!).metadata()).format
    ).toBe("webp");
    expect((await request(asset.posterUrl)).status).toBe(200);
    const mainTicket = new URL(asset.url, origin).searchParams.get("ticket");
    expect(
      (
        await request(
          `/api/media/profile/${asset.id}/poster?ticket=${mainTicket}`
        )
      ).status
    ).toBe(404);
    await publishAsset(asset);
    const resource = `/api/media/profile/${asset.id}`;
    const range = await fetch(origin + resource, {
      headers: { Range: "bytes=4-15" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 4-15/${raw.bytes}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      fake.objects.get(raw.objectKey)!.subarray(4, 16)
    );
    const suffix = await fetch(origin + resource, {
      headers: { Range: "bytes=-7" },
    });
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(7);
    const all = await request(resource);
    expect(all.status).toBe(200);
    expect((await all.arrayBuffer()).byteLength).toBeLessThanOrEqual(
      PROFILE_LIMITS.videoBytes
    );
    for (const value of [
      "bytes=999999999-",
      "bytes=20-10",
      "bytes=-0",
      "bytes=0-1,5-6",
      "bytes=9007199254740993-",
    ]) {
      const invalid = await fetch(origin + resource, {
        headers: { Range: value },
      });
      expect(invalid.status).toBe(416);
      expect(invalid.headers.get("content-range")).toBe(`bytes */${raw.bytes}`);
    }
    const fields = input();
    fields.backgroundMediaId = asset.id;
    fields.theme.backgroundMode = "image";
    expect((await save(fields)).status).toBe(400);
  }, 30_000);
  it("accepts a real portrait WebM and preserves aspect ratio within 1280x720", async () => {
    const response = await upload(form(webm, "background", "video/webm"));
    expect(response.status).toBe(201);
    const asset = await response.json();
    expect(asset.kind).toBe("video");
    expect(asset.width).toBe(180);
    expect(asset.height).toBe(320);
  }, 30_000);
  it("rejects video in static-only slots, corrupt/mismatched containers, over-30-second and oversize sources", async () => {
    expect((await upload(form(mp4, "avatar", "video/mp4"))).status).toBe(415);
    expect((await upload(form(mp4, "ghost", "video/mp4"))).status).toBe(415);
    expect(
      (await upload(form(Buffer.from("no video"), "background", "video/mp4")))
        .status
    ).toBe(415);
    expect(
      (
        await upload(
          form(
            Buffer.from("#EXTM3U\nhttps://never-follow.invalid/secret"),
            "background",
            "video/mp4"
          )
        )
      ).status
    ).toBe(415);
    expect((await upload(form(mp4, "background", "video/webm"))).status).toBe(
      415
    );
    expect(
      (await upload(form(longVideo, "background", "video/mp4"))).status
    ).toBe(422);
    expect(
      (
        await upload(
          form(
            Buffer.alloc(PROFILE_LIMITS.videoBytes + 1),
            "background",
            "video/mp4"
          )
        )
      ).status
    ).toBe(413);
    expect(fake.puts).not.toHaveBeenCalled();
  }, 30_000);
  it("cleans upload scratch directories on native codec errors and successful processing", async () => {
    const before = (await readdir(tmpdir()))
      .filter(name => /^respawn-profile-/.test(name))
      .sort();
    const invalid = await upload(
      form(
        Buffer.concat([mp4.subarray(0, 32), Buffer.from("no codec")]),
        "background",
        "video/mp4"
      )
    );
    expect(invalid.status).toBe(422);
    expect((await upload(form())).status).toBe(201);
    await vi.waitFor(async () =>
      expect(
        (await readdir(tmpdir()))
          .filter(name => /^respawn-profile-/.test(name))
          .sort()
      ).toEqual(before)
    );
  });
  it("honors an aborted native processing deadline without creating media records", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      processProfileVideo(
        path.join(directory, "source.mp4"),
        directory,
        "video/mp4",
        controller.signal
      )
    ).rejects.toMatchObject({ status: 422 });
    expect(fake.creates).not.toHaveBeenCalled();
  });
});

describe("profile media deadlines and additional native safety checks", () => {
  it.each(["signing", "fetch"])(
    "bounds a stalled %s operation with a real deadline",
    async mode => {
      const asset = await image();
      await publishAsset(asset);
      if (mode === "signing") fake.signGate = new Promise<string>(() => {});
      else fake.mode = "stall";
      const started = Date.now(),
        response = await request(`/api/media/profile/${asset.id}`);
      expect(response.status).toBe(504);
      expect(Date.now() - started).toBeLessThan(12_000);
      expect(await response.text()).not.toContain("SECRET");
    },
    15_000
  );
  it("bounds concurrent uploads across different users", async () => {
    let release!: () => void;
    fake.putGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = upload(form(), 1),
      second = upload(form(), 2);
    await vi.waitFor(() => expect(fake.puts).toHaveBeenCalledTimes(2));
    try {
      expect((await upload(form(), 3)).status).toBe(429);
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
  });
  it("rejects a real animated WebP produced by FFmpeg", async () => {
    const animated = path.join(directory, "animated.webp");
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
        "testsrc2=size=80x40:rate=4",
        "-t",
        "1",
        "-c:v",
        "libwebp_anim",
        "-threads",
        "2",
        "-loop",
        "0",
        animated,
      ],
      undefined,
      10_000
    );
    const bytes = await readFile(animated);
    expect(
      (await sharp(bytes, { animated: true }).metadata()).pages
    ).toBeGreaterThan(1);
    expect((await upload(form(bytes, "ghost", "image/webp"))).status).toBe(415);
    expect(fake.puts).not.toHaveBeenCalled();
  }, 15_000);
  it("preserves actual display aspect for anamorphic video rather than stretching it", async () => {
    const input = path.join(directory, "anamorphic.mp4"),
      output = await mkdtemp(path.join(directory, "anamorphic-output-"));
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
        "testsrc2=size=160x180:rate=12",
        "-vf",
        "setsar=2",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-pix_fmt",
        "yuv420p",
        input,
      ],
      undefined,
      10_000
    );
    const normalized = await processProfileVideo(input, output, "video/mp4");
    expect(normalized).toMatchObject({ width: 320, height: 180 });
  }, 15_000);
  it("rejects real QuickTime and arbitrary Matroska masquerading as MP4/WebM", async () => {
    const mov = path.join(directory, "not-mp4.mov"),
      mkv = path.join(directory, "not-webm.mkv");
    await command(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        path.join(directory, "source.mp4"),
        "-c:v",
        "copy",
        "-an",
        "-f",
        "mov",
        mov,
      ],
      undefined,
      10_000
    );
    await command(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        path.join(directory, "source.webm"),
        "-c:v",
        "copy",
        "-an",
        "-f",
        "matroska",
        mkv,
      ],
      undefined,
      10_000
    );
    expect(
      (await upload(form(await readFile(mov), "background", "video/mp4")))
        .status
    ).toBe(415);
    expect(
      (await upload(form(await readFile(mkv), "background", "video/webm")))
        .status
    ).toBe(415);
    expect(fake.puts).not.toHaveBeenCalled();
  }, 15_000);
});

describe("artwork renewal and social-link round trips", () => {
  it("renews owner-only draft artwork metadata without a saved profile or new writes", async () => {
    const asset = await image();
    const created = fake.creates.mock.calls.length;
    const response = await request(`/api/app/profile/media/${asset.id}`, 1);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(asset.id);
    expect(body.url).toContain("?ticket=");
    expect(JSON.stringify(body)).not.toMatch(
      /SECRET-KEY|objectKey|signed=NEVER-EXPOSE/
    );
    expect(
      (await request(`/api/app/profile/media/${asset.id}`, 2)).status
    ).toBe(404);
    expect((await request(`/api/app/profile/media/${asset.id}`)).status).toBe(
      404
    );
    expect(fake.creates).toHaveBeenCalledTimes(created);
    expect(fake.signs).not.toHaveBeenCalled();
  });
  it("rechecks profile visibility and media references on every artwork renewal", async () => {
    const asset = await image();
    await publishAsset(asset, "members");
    expect((await request(`/api/app/profile/media/${asset.id}`)).status).toBe(
      404
    );
    expect(
      (await request(`/api/app/profile/media/${asset.id}`, 2)).status
    ).toBe(200);
    const profile = fake.records.get("profile/profile:1");
    profile.settings.visibility = "private";
    expect(
      (await request(`/api/app/profile/media/${asset.id}`, 2)).status
    ).toBe(404);
    profile.settings.visibility = "public";
    profile.avatarMediaId = null;
    expect(
      (await request(`/api/app/profile/media/${asset.id}`, 2)).status
    ).toBe(404);
    expect(
      (await request(`/api/app/profile/media/${asset.id}`, 1)).status
    ).toBe(200);
  });
  it("accepts only HTTPS social links that the profile editor can round-trip", async () => {
    for (const url of [
      "http://example.com/channel",
      "https://localhost/channel",
    ]) {
      const fields = input();
      fields.links = [{ label: "My channel", url }];
      expect((await save(fields)).status).toBe(400);
    }
    const fields = input();
    fields.links = [
      { label: "My channel", url: "https://example.com/channel" },
    ];
    expect((await save(fields)).status).toBe(200);
    expect(
      (await (await request("/api/app/profile/me", 1)).json()).links
    ).toEqual(fields.links);
  });
});
