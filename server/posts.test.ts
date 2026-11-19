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
import sharp from "sharp";
import type { Lounge } from "../shared/app-types";
import type { RegularPost } from "../shared/post-types";
import { POST_LIMITS } from "../shared/post-types";

const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  locks: new Map<string, Promise<void>>(),
  objects: new Map<string, Buffer>(),
  upstream: "",
  ticketIdentity: 2,
  puts: vi.fn(),
  signs: vi.fn(),
  readHook: undefined as undefined | (() => void),
  getHook: undefined as undefined | ((kind: string, id: string) => void),
  putGate: undefined as undefined | Promise<void>,
  mode: "normal",
}));
vi.mock("./features/store", () => ({
  list: async (kind: string) =>
    [...fake.records.entries()]
      .filter(([key]) => key.startsWith(kind + "/"))
      .map(([, value]) => structuredClone(value)),
  get: async (kind: string, id: string) => {
    fake.getHook?.(kind, id);
    return structuredClone(fake.records.get(`${kind}/${id}`));
  },
  create: async (kind: string, _owner: number, data: { id: string }) => {
    fake.records.set(`${kind}/${data.id}`, structuredClone(data));
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
          limit: async () => [
            { id: fake.ticketIdentity, name: "Ticket member" },
          ],
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
  storagePut: async (path: string, data: Buffer, mime: string) => {
    fake.puts(path, data, mime);
    if (fake.putGate) await fake.putGate;
    const key = `SECRET-STORAGE/${path}`;
    fake.objects.set(key, Buffer.from(data));
    return { key, url: `https://private-storage.invalid/${key}?secret=SIGNED` };
  },
  storageGetSignedUrl: async (key: string) => {
    fake.signs(key);
    return `${fake.upstream}/objects/${encodeURIComponent(key)}`;
  },
}));
import { registerPostRoutes } from "./features/posts";
import { mediaTicket } from "./features/access";

let server: Server, remote: Server, origin: string;
let png: Buffer, jpeg: Buffer, webp: Buffer;
const port = (server: Server) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerPostRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  origin = port(server);
  const storage = express();
  storage.get("/objects/:key", async (req, res) => {
    fake.readHook?.();
    if (fake.mode === "redirect") {
      res.redirect("https://never-follow.invalid/private-key");
      return;
    }
    if (fake.mode === "stall") return;
    if (fake.mode === "huge") {
      res.set("Content-Length", String(POST_LIMITS.photoBytes + 1)).end();
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
    res.type("image/webp").send(bytes);
  });
  remote = storage.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => remote.once("listening", resolve));
  fake.upstream = port(remote);
  const input = sharp({
    create: { width: 80, height: 40, channels: 3, background: "#36c" },
  });
  png = await input.clone().png().toBuffer();
  jpeg = await input.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer();
  webp = await input.clone().webp().toBuffer();
});
afterAll(async () => {
  await Promise.all(
    [server, remote].map(
      instance =>
        new Promise<void>((resolve, reject) => {
          instance.close(error => (error ? reject(error) : resolve()));
          instance.closeAllConnections();
        })
    )
  );
  vi.unstubAllEnvs();
});
beforeEach(() => {
  fake.records.clear();
  fake.locks.clear();
  fake.objects.clear();
  fake.puts.mockClear();
  fake.signs.mockClear();
  fake.mode = "normal";
  fake.readHook = undefined;
  fake.getHook = undefined;
  fake.putGate = undefined;
  fake.ticketIdentity = 2;
  vi.stubEnv("MANUS_JWT_SECRET", "post-unit-test-only-secret");
  vi.stubEnv("MANUS_PROJECT_ID", "post-unit-test-only-project");
});
function lounge(
  privacy: "public" | "private" = "private",
  members = [1, 2]
): Lounge {
  const record: Lounge = {
    id: "lounge-one",
    ownerId: 1,
    name: "Test Lounge",
    description: "",
    game: "",
    privacy,
    members,
    requests: [],
    createdAt: new Date().toISOString(),
  };
  fake.records.set("lounge/" + record.id, record);
  return record;
}
async function request(
  path: string,
  user?: number,
  method = "GET",
  body?: unknown,
  originHeader = origin
) {
  return fetch(origin + path, {
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
function form({
  text = "Photo post",
  destination = "profile",
  loungeId,
  confirmed = "true",
  photos = [png],
  mime = "image/png",
}: {
  text?: string;
  destination?: string;
  loungeId?: string;
  confirmed?: string;
  photos?: Buffer[];
  mime?: string;
} = {}) {
  const body = new FormData();
  body.append("text", text);
  body.append("destination", destination);
  if (loungeId !== undefined) body.append("loungeId", loungeId);
  body.append("confirmed", confirmed);
  for (const photo of photos)
    body.append(
      "photos",
      new Blob([new Uint8Array(photo)], { type: mime }),
      "test-photo"
    );
  return body;
}
async function upload(
  body = form(),
  user: number | undefined = 1,
  originHeader = origin
) {
  return fetch(origin + "/api/app/posts", {
    method: "POST",
    headers: {
      ...(user ? { Authorization: `Bearer ${user}` } : {}),
      Origin: originHeader,
    },
    body,
  });
}
async function create(
  options?: Parameters<typeof form>[0],
  user = 1
): Promise<RegularPost> {
  const response = await upload(form(options), user);
  expect(response.status).toBe(201);
  return response.json();
}
async function jsonPost(text = "Text post", user = 1) {
  const response = await request("/api/app/posts", user, "POST", {
    text,
    destination: "profile",
    confirmed: true,
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<RegularPost>;
}
const photoPath = (post: RegularPost, index = 0) =>
  `/api/media/post-photo/${post.id}/${post.photos[index].id}`;

describe("regular post HTTP mutation validation", () => {
  it("requires sign-in and same-origin before multipart bytes, and explicit confirmation for every mutation", async () => {
    expect((await upload(form(), 0)).status).toBe(401);
    expect((await upload(form(), 1, "https://outside.invalid")).status).toBe(
      403
    );
    expect((await upload(form({ confirmed: "false" }))).status).toBe(400);
    expect(
      (
        await request("/api/app/posts", 1, "POST", {
          text: "No confirmation",
          destination: "profile",
        })
      ).status
    ).toBe(400);
    expect(fake.puts).not.toHaveBeenCalled();
    expect(fake.records.size).toBe(0);
    const post = await jsonPost();
    expect(
      (
        await request(`/api/app/posts/${post.id}`, 1, "PATCH", {
          text: "Edit",
          keepPhotoIds: [],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request(`/api/app/posts/${post.id}`, 1, "DELETE", {
          confirmed: "true",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request(
          `/api/app/posts/${post.id}`,
          1,
          "DELETE",
          { confirmed: true },
          "https://outside.invalid"
        )
      ).status
    ).toBe(403);
  });
  it("persists text-only JSON, multipart text-only and photo-only posts; rejects empty and overlength posts", async () => {
    const textOnly = await jsonPost("  Real text  ");
    expect(textOnly.text).toBe("Real text");
    expect(textOnly.photos).toEqual([]);
    expect(
      (await upload(form({ photos: [], text: "Multipart text" }))).status
    ).toBe(201);
    expect((await create({ text: "" })).photos).toHaveLength(1);
    for (const text of ["  \n ", "x".repeat(POST_LIMITS.text + 1)]) {
      expect(
        (
          await request("/api/app/posts", 1, "POST", {
            text,
            destination: "profile",
            confirmed: true,
          })
        ).status
      ).toBe(400);
      expect((await upload(form({ text, photos: [] }))).status).toBe(400);
    }
    expect(
      (await upload(form({ text: "x".repeat(POST_LIMITS.text + 1) }))).status
    ).toBe(400);
  });
  it("accepts the exact text and photo-count limits", async () => {
    const response = await upload(
      form({ text: "x".repeat(POST_LIMITS.text), photos: [png, png, png, png] })
    );
    expect(response.status).toBe(201);
    const post = await response.json();
    expect(post.text).toHaveLength(POST_LIMITS.text);
    expect(post.photos).toHaveLength(4);
  });
  it("rejects too many photos, oversized files, unexpected files, duplicate fields and malformed multipart with JSON errors", async () => {
    expect(
      (await upload(form({ photos: Array.from({ length: 5 }, () => png) })))
        .status
    ).toBe(400);
    expect(
      (
        await upload(
          form({ photos: [Buffer.alloc(POST_LIMITS.photoBytes + 1)] })
        )
      ).status
    ).toBe(413);
    const unexpected = form({ photos: [] });
    unexpected.append(
      "file",
      new Blob([new Uint8Array(png)], { type: "image/png" }),
      "x.png"
    );
    expect((await upload(unexpected)).status).toBe(400);
    const duplicate = form({ photos: [] });
    duplicate.append("destination", "profile");
    duplicate.append(
      "photos",
      new Blob([new Uint8Array(png)], { type: "image/png" }),
      "x.png"
    );
    expect((await upload(duplicate)).status).toBe(400);
    const invalid = await fetch(origin + "/api/app/posts", {
      method: "POST",
      headers: {
        Authorization: "Bearer 1",
        Origin: origin,
        "Content-Type": "multipart/form-data; boundary=missing",
      },
      body: "invalid",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toHaveProperty("error");
    expect(fake.puts).not.toHaveBeenCalled();
  });
  it("validates destination and current membership before any storage, including when fields are sent after a photo", async () => {
    lounge();
    expect(
      (await upload(form({ destination: "lounge", loungeId: "lounge-one" }), 3))
        .status
    ).toBe(403);
    expect(
      (await upload(form({ destination: "lounge", loungeId: "missing" }), 1))
        .status
    ).toBe(403);
    expect((await upload(form({ destination: "invalid" }))).status).toBe(400);
    const late = new FormData();
    late.append(
      "photos",
      new Blob([new Uint8Array(png)], { type: "image/png" }),
      "x.png"
    );
    late.append("text", "Too late");
    late.append("destination", "profile");
    late.append("confirmed", "true");
    expect((await upload(late)).status).toBe(400);
    const forged = form();
    forged.append("audience", "public");
    expect((await upload(forged)).status).toBe(400);
    expect(fake.puts).not.toHaveBeenCalled();
    expect(fake.records.has("post/anything")).toBe(false);
  });
  it("rechecks membership after multipart and before storage, and refuses trailing destination replacement", async () => {
    const room = lounge();
    let reads = 0;
    fake.getHook = kind => {
      if (kind === "lounge" && ++reads === 2) room.members = [1];
    };
    expect(
      (await upload(form({ destination: "lounge", loungeId: room.id }), 2))
        .status
    ).toBe(403);
    expect(fake.puts).not.toHaveBeenCalled();
    fake.getHook = undefined;
    const replacement = form();
    replacement.append("destination", "lounge");
    expect((await upload(replacement)).status).toBe(400);
    expect(fake.puts).not.toHaveBeenCalled();
  });
  it("bounds per-user and total concurrent uploads and releases slots after completion", async () => {
    let release!: () => void;
    fake.putGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const first = upload(form(), 1);
    await vi.waitFor(() => expect(fake.puts).toHaveBeenCalledTimes(1));
    expect((await upload(form(), 1)).status).toBe(429);
    const second = upload(form(), 2);
    await vi.waitFor(() => expect(fake.puts).toHaveBeenCalledTimes(2));
    expect((await upload(form(), 3)).status).toBe(429);
    release();
    expect((await first).status).toBe(201);
    expect((await second).status).toBe(201);
    fake.putGate = undefined;
    expect((await upload(form(), 1)).status).toBe(201);
  });
});

describe("real Sharp photo sanitization and application-owned delivery", () => {
  it("checks magic and decoder, rejects SVG, MIME spoofing and corrupt input without storing any photo", async () => {
    for (const [bytes, mime, status] of [
      [
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        ),
        "image/png",
        415,
      ],
      [png, "image/jpeg", 415],
      [Buffer.from([255, 216, 255, 0, 0]), "image/jpeg", 422],
      [png.subarray(0, 30), "image/png", 422],
      [png, "image/svg+xml", 415],
    ] as [Buffer, string, number][]) {
      expect((await upload(form({ photos: [bytes], mime }))).status).toBe(
        status
      );
    }
    expect(
      (await upload(form({ photos: [png, png.subarray(0, 30)] }))).status
    ).toBe(422);
    expect(fake.puts).not.toHaveBeenCalled();
  });
  it("rejects animated containers and excessive input pixels", async () => {
    const huge = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    expect((await upload(form({ photos: [huge] }))).status).toBe(422);
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8);
    chunk.write("acTL", 4);
    const apng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    expect((await upload(form({ photos: [apng] }))).status).toBe(415);
    const animatedWebp = Buffer.from(webp);
    animatedWebp.write("ANIM", 12);
    expect(
      (await upload(form({ photos: [animatedWebp], mime: "image/webp" })))
        .status
    ).toBe(415);
    expect(fake.puts).not.toHaveBeenCalled();
  });
  it("accepts JPEG/PNG/WebP, strips EXIF and rotates JPEG, and serves the actual sanitized WebP bytes", async () => {
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    for (const [bytes, mime, width, height] of [
      [jpeg, "image/jpeg", 40, 80],
      [png, "image/png", 80, 40],
      [webp, "image/webp", 80, 40],
    ] as [Buffer, string, number, number][]) {
      const post = await create({ photos: [bytes], mime });
      expect(post.photos[0]).toMatchObject({ width, height });
      const raw = fake.records.get("post/" + post.id);
      expect(raw.photos[0].key).toContain("SECRET-STORAGE");
      const stored = fake.objects.get(raw.photos[0].key)!;
      const metadata = await sharp(stored).metadata();
      expect(metadata).toMatchObject({ format: "webp", width, height });
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      const response = await request(post.photos[0].url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/webp");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const delivered = Buffer.from(await response.arrayBuffer());
      expect(delivered.equals(stored)).toBe(true);
      const pixels = await sharp(delivered)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(pixels.info.width).toBe(width);
      expect(JSON.stringify(post)).not.toMatch(
        /SECRET|SIGNED|storage|\.invalid|"key"|"bytes"/
      );
    }
  });
  it("bounds output dimensions to 2048 while preserving aspect ratio", async () => {
    const wide = await sharp({
      create: { width: 3000, height: 1500, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const post = await create({ photos: [wide] });
    expect(post.photos[0]).toMatchObject({ width: 2048, height: 1024 });
    const response = await request(post.photos[0].url);
    expect(
      await sharp(Buffer.from(await response.arrayBuffer())).metadata()
    ).toMatchObject({ width: 2048, height: 1024 });
  });
  it("does not follow storage redirects and bounds declared and streamed upstream bytes", async () => {
    const post = await create();
    for (const mode of ["redirect", "huge", "overrun"]) {
      fake.mode = mode;
      const response = await request(photoPath(post));
      expect(response.status).toBe(502);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toMatch(
        /SECRET|SIGNED|never-follow|private-key/
      );
    }
  });
  it("uses a bounded deadline and noncached, nonredirecting storage fetch", async () => {
    const post = await create();
    fake.mode = "stall";
    const actualFetch = globalThis.fetch;
    const calls: RequestInit[] = [];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, options) => {
        if (String(input).startsWith(fake.upstream)) calls.push(options!);
        return actualFetch(input, options);
      });
    try {
      const response = await request(photoPath(post));
      expect(response.status).toBe(504);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ cache: "no-store", redirect: "error" });
      expect(calls[0].signal?.aborted).toBe(true);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    } finally {
      spy.mockRestore();
    }
  }, 15_000);
});

describe("current Lounge ACL, immutable audience and soft revocation", () => {
  it("filters private posts in feeds, owner filters, direct reads and photos before signing storage", async () => {
    const room = lounge();
    const post = await create({ destination: "lounge", loungeId: room.id }, 2);
    await jsonPost("Visible profile", 3);
    for (const user of [undefined, 3]) {
      const feed = await (await request("/api/app/posts", user)).json();
      expect(feed).toHaveLength(1);
      expect(feed[0].text).toBe("Visible profile");
      expect(
        await (await request("/api/app/posts?ownerId=2", user)).json()
      ).toEqual([]);
      expect(
        (await request("/api/app/posts?loungeId=" + room.id, user)).status
      ).toBe(404);
      expect((await request(`/api/app/posts/${post.id}`, user)).status).toBe(
        404
      );
      expect((await request(photoPath(post), user)).status).toBe(404);
    }
    expect(fake.signs).not.toHaveBeenCalled();
    expect((await request(`/api/app/posts/${post.id}`, 1)).status).toBe(200);
    expect((await request(photoPath(post), 1)).status).toBe(200);
    room.members = [1];
    expect((await request(`/api/app/posts/${post.id}`, 2)).status).toBe(200); // Author retains access.
    expect((await request(`/api/app/posts/${post.id}`, 3)).status).toBe(404);
  });
  it("rechecks current Lounge privacy and missing Lounges; private creation never becomes public", async () => {
    const room = lounge("public");
    const originallyPublic = await create({
      destination: "lounge",
      loungeId: room.id,
    });
    expect(
      (await request(`/api/app/posts/${originallyPublic.id}`)).status
    ).toBe(200);
    room.privacy = "private";
    expect(
      (await request(`/api/app/posts/${originallyPublic.id}`)).status
    ).toBe(404);
    expect((await request(photoPath(originallyPublic))).status).toBe(404);
    expect(
      (await (await request(`/api/app/posts/${originallyPublic.id}`, 2)).json())
        .audience
    ).toBe("lounge");
    const originallyPrivate = await create({
      destination: "lounge",
      loungeId: room.id,
    });
    room.privacy = "public";
    expect(
      (await request(`/api/app/posts/${originallyPublic.id}`)).status
    ).toBe(200);
    expect(
      (await request(`/api/app/posts/${originallyPrivate.id}`)).status
    ).toBe(404);
    expect((await request(photoPath(originallyPrivate), 3)).status).toBe(404);
    fake.records.delete("lounge/" + room.id);
    for (const post of [originallyPublic, originallyPrivate]) {
      expect((await request(`/api/app/posts/${post.id}`, 1)).status).toBe(404);
      expect((await request(photoPath(post), 1)).status).toBe(404);
    }
  });
  it("uses exact-resource tickets and rechecks membership even when the ticket is valid", async () => {
    const room = lounge();
    const post = await create({ destination: "lounge", loungeId: room.id });
    const memberPost: RegularPost = await (
      await request(`/api/app/posts/${post.id}`, 2)
    ).json();
    expect(memberPost.photos[0].url).toContain("?ticket=");
    expect((await request(memberPost.photos[0].url)).status).toBe(200);
    const wrong = mediaTicket(`post-photo/${post.id}/other-photo`, 2);
    expect((await request(photoPath(post) + "?ticket=" + wrong)).status).toBe(
      404
    );
    const wrongKind = mediaTicket(`clip/${post.id}`, 2);
    expect(
      (await request(photoPath(post) + "?ticket=" + wrongKind)).status
    ).toBe(404);
    expect((await request(memberPost.photos[0].url + "x")).status).toBe(404);
    room.members = [1];
    expect((await request(memberPost.photos[0].url)).status).toBe(404);
    expect((await request(`/api/app/posts/${post.id}`, 2)).status).toBe(404);
  });
  it("only permits author text edits/photo removal; preserves destination and revokes removed-photo URLs", async () => {
    const room = lounge(),
      post = await create({
        destination: "lounge",
        loungeId: room.id,
        photos: [png, png],
      });
    const path = `/api/app/posts/${post.id}`;
    const edit = {
      text: "Updated text",
      keepPhotoIds: [post.photos[0].id],
      confirmed: true,
    };
    expect((await request(path, 2, "PATCH", edit)).status).toBe(403);
    expect((await request(path, 2, "DELETE", { confirmed: true })).status).toBe(
      403
    );
    expect(
      (await request(path, 1, "PATCH", { ...edit, destination: "profile" }))
        .status
    ).toBe(400);
    expect(
      (await request(path, 1, "PATCH", { ...edit, audience: "public" })).status
    ).toBe(400);
    expect(
      (await request(path, 1, "PATCH", { ...edit, keepPhotoIds: ["unknown"] }))
        .status
    ).toBe(400);
    expect(
      (
        await request(path, 1, "PATCH", {
          ...edit,
          keepPhotoIds: [post.photos[0].id, post.photos[0].id],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request(path, 1, "PATCH", {
          text: "",
          keepPhotoIds: [],
          confirmed: true,
        })
      ).status
    ).toBe(400);
    const response = await request(path, 1, "PATCH", edit);
    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated).toMatchObject({
      text: "Updated text",
      destination: "lounge",
      audience: "lounge",
      loungeId: room.id,
    });
    expect(updated.updatedAt).toBeTruthy();
    expect(updated.photos).toHaveLength(1);
    expect((await request(photoPath(post, 1), 1)).status).toBe(404);
    expect((await request(photoPath(post), 1)).status).toBe(200);
    expect(JSON.stringify(updated)).not.toMatch(/SECRET|SIGNED|"key"/);
  });
  it("soft-deletes without promising physical deletion and revokes all old post and photo URLs", async () => {
    const post = await create(),
      path = `/api/app/posts/${post.id}`;
    const deleted = await request(path, 1, "DELETE", { confirmed: true });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(fake.records.get("post/" + post.id).deletedAt).toBeTruthy();
    expect(fake.objects.size).toBe(1);
    expect((await request(path, 1)).status).toBe(404);
    expect((await request(photoPath(post), 1)).status).toBe(404);
    expect(await (await request("/api/app/posts", 1)).json()).toEqual([]);
    expect(
      (
        await request(path, 1, "PATCH", {
          text: "Restore",
          keepPhotoIds: [],
          confirmed: true,
        })
      ).status
    ).toBe(404);
  });
  it("rechecks revocation after remote storage reads before delivering any bytes", async () => {
    const post = await create();
    fake.readHook = () => {
      fake.records.get("post/" + post.id).deletedAt = new Date().toISOString();
    };
    const response = await request(photoPath(post));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("json");
  });
  it("returns newest 50 accessible posts and applies validated author/Lounge filters", async () => {
    const post = await jsonPost();
    const raw = fake.records.get("post/" + post.id);
    fake.records.clear();
    for (let index = 0; index < 60; index++)
      fake.records.set(`post/post-${index}`, {
        ...raw,
        id: `post-${index}`,
        ownerId: (index % 2) + 1,
        createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      });
    const posts = await (await request("/api/app/posts")).json();
    expect(posts).toHaveLength(50);
    expect(posts[0].id).toBe("post-59");
    expect(posts[49].id).toBe("post-10");
    expect(
      await (await request("/api/app/posts?ownerId=2")).json()
    ).toHaveLength(30);
    expect((await request("/api/app/posts?ownerId=invalid")).status).toBe(400);
    expect((await request("/api/app/posts?loungeId=missing")).status).toBe(404);
  });
});
