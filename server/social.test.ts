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
import { defaultProfile, type Profile } from "../shared/profile-types";
import { REACTION_EMOJIS } from "../shared/social-types";

const fake = vi.hoisted(() => ({
  records: new Map<string, any>(),
  locks: new Map<string, Promise<void>>(),
  posts: new Map<
    string,
    { ownerId: number; members?: number[]; deleted?: boolean }
  >(),
  aclCalls: [] as [string, number | undefined][],
  listCalls: [] as string[],
  duplicateCreates: 0,
  mutationAttempts: 0,
  mutationFailures: [] as string[],
  listHook: undefined as undefined | ((kind: string) => void),
  getHook: undefined as undefined | ((kind: string, id: string) => void),
  createHook: undefined as undefined | ((kind: string) => void),
  createFailure: undefined as undefined | string,
  createGate: undefined as undefined | Promise<void>,
  pendingCreates: 0,
}));
vi.mock("./features/store", () => ({
  get: async (kind: string, id: string) => {
    fake.getHook?.(kind, id);
    return structuredClone(fake.records.get(`${kind}/${id}`));
  },
  list: async (kind: string) => {
    fake.listCalls.push(kind);
    // Copy before the hook so tests catch privacy changes during aggregation.
    const rows = [...fake.records.entries()]
      .filter(([key]) => key.startsWith(`${kind}/`))
      .map(([, value]) => structuredClone(value));
    fake.listHook?.(kind);
    return rows;
  },
  create: async (kind: string, _ownerId: number, value: { id: string }) => {
    // Yield so simultaneous first requests really contend on the unique key.
    await Promise.resolve();
    fake.pendingCreates++;
    if (fake.createGate) await fake.createGate;
    if (fake.createFailure)
      throw Object.assign(new Error("Test storage failure"), {
        code: fake.createFailure,
      });
    const key = `${kind}/${value.id}`;
    if (fake.records.has(key)) {
      fake.duplicateCreates++;
      throw Object.assign(new Error("Drizzle test duplicate"), {
        cause: Object.assign(new Error("Duplicate"), { code: "ER_DUP_ENTRY" }),
      });
    }
    fake.records.set(key, structuredClone(value));
    fake.createHook?.(kind);
    return structuredClone(value);
  },
  mutate: async (kind: string, id: string, fn: (value: any) => any) => {
    fake.mutationAttempts++;
    const failure = fake.mutationFailures.shift();
    if (failure)
      throw Object.assign(new Error("Test transaction rollback"), {
        code: failure,
      });
    const key = `${kind}/${id}`;
    const previous = fake.locks.get(key) ?? Promise.resolve();
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
        throw Object.assign(new Error("Record not found"), { status: 404 });
      const next = fn(structuredClone(fake.records.get(key)));
      if (next.id !== id) throw new Error("Identity changed");
      fake.records.set(key, structuredClone(next));
      return structuredClone(next);
    } finally {
      release();
    }
  },
  database: () => {
    throw new Error("Social tests must never access a real database");
  },
}));
vi.mock("./_core/sdk", () => ({
  sdk: {
    authenticateRequest: async (req: Request) => {
      const id = Number(req.get("authorization")?.replace("Bearer ", ""));
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error("No test identity");
      return { id, name: `Authenticated member ${id}` };
    },
  },
}));
vi.mock("./features/posts", () => ({
  assertPostReadable: async (postId: string, viewerId?: number) => {
    fake.aclCalls.push([postId, viewerId]);
    const post = fake.posts.get(postId);
    if (
      !post ||
      post.deleted ||
      (post.members && !post.members.includes(viewerId ?? 0))
    )
      throw Object.assign(new Error("Post not found"), { status: 404 });
    return { ownerId: post.ownerId };
  },
}));
import { registerSocialRoutes } from "./features/social";

let server: Server, origin: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerSocialRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
});
beforeEach(() => {
  fake.records.clear();
  fake.locks.clear();
  fake.posts.clear();
  fake.aclCalls = [];
  fake.listCalls = [];
  fake.duplicateCreates = 0;
  fake.mutationAttempts = 0;
  fake.mutationFailures = [];
  fake.listHook = undefined;
  fake.getHook = undefined;
  fake.createHook = undefined;
  fake.createFailure = undefined;
  fake.createGate = undefined;
  fake.pendingCreates = 0;
  vi.restoreAllMocks();
});
async function request(
  path: string,
  userId?: number,
  method = "GET",
  body?: unknown,
  options: { origin?: string | null; headers?: Record<string, string> } = {}
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      ...(userId ? { Authorization: `Bearer ${userId}` } : {}),
      ...(method !== "GET"
        ? {
            ...(options.origin === null
              ? {}
              : { Origin: options.origin ?? origin }),
            "Content-Type": "application/json",
          }
        : {}),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? JSON.parse(text)
    : text;
  return { status: response.status, data, headers: response.headers };
}
function profile(ownerId = 1, settings: Partial<Profile["settings"]> = {}) {
  const value = {
    ...defaultProfile(ownerId, `Saved member ${ownerId}`),
    id: `profile:${ownerId}`,
    saved: true,
  };
  value.settings = { ...value.settings, ...settings };
  fake.records.set(`profile/profile:${ownerId}`, value);
  return value;
}
function post(id = "post-one", ownerId = 1, members?: number[]) {
  const value: { ownerId: number; members?: number[]; deleted?: boolean } = {
    ownerId,
    members,
  };
  fake.posts.set(id, value);
  return value;
}
function rows(kind: string) {
  return [...fake.records.entries()]
    .filter(([key]) => key.startsWith(kind + "/"))
    .map(([, row]) => row);
}
const follow = (userId: number, following = true, ownerId = 1) =>
  request(`/api/app/profiles/${ownerId}/follow`, userId, "POST", {
    following,
    confirmed: true,
  });
const reaction = (userId: number, emoji: unknown = "🔥", postId = "post-one") =>
  request(`/api/app/posts/${postId}/reaction`, userId, "POST", {
    emoji,
    confirmed: true,
  });
const comment = (
  userId: number,
  text = "A real comment",
  postId = "post-one"
) =>
  request(`/api/app/posts/${postId}/comments`, userId, "POST", {
    text,
    confirmed: true,
  });
const removeComment = (
  commentId: string,
  userId: number,
  postId = "post-one"
) =>
  request(`/api/app/posts/${postId}/comments/${commentId}`, userId, "DELETE", {
    confirmed: true,
  });
function seededComment(
  id: string,
  ownerId = 2,
  overrides: Record<string, unknown> = {}
) {
  const value = {
    id,
    postId: "post-one",
    ownerId,
    ownerName: `Member ${ownerId}`,
    text: "PRIVATE COMMENT CONTENT",
    createdAt: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
  fake.records.set(`post-comment/${id}`, value);
  return value;
}

describe("social mutation authentication and strict payloads over real Express HTTP", () => {
  it("requires authentication, same-origin, and confirmed:true for every write without touching storage", async () => {
    profile();
    post();
    seededComment("existing");
    const writes: [string, string, Record<string, unknown>][] = [
      ["/api/app/profiles/1/follow", "POST", { following: true }],
      ["/api/app/posts/post-one/reaction", "POST", { emoji: "🔥" }],
      ["/api/app/posts/post-one/comments", "POST", { text: "hello" }],
      ["/api/app/posts/post-one/comments/existing", "DELETE", {}],
    ];
    const initial = structuredClone(fake.records);
    for (const [path, method, input] of writes) {
      expect(
        (await request(path, undefined, method, { ...input, confirmed: true }))
          .status
      ).toBe(401);
      expect(
        (
          await request(
            path,
            2,
            method,
            { ...input, confirmed: true },
            { origin: "https://evil.invalid" }
          )
        ).status
      ).toBe(403);
      for (const confirmed of [undefined, false, "true", 1]) {
        expect(
          (await request(path, 2, method, { ...input, confirmed })).status
        ).toBe(400);
      }
      expect(
        (
          await request(path, 2, method, {
            ...input,
            confirmed: true,
            ownerId: 99,
          })
        ).status
      ).toBe(400);
    }
    expect(fake.records).toEqual(initial);
    expect(fake.aclCalls).toEqual([]);
  });
  it("rejects missing Origin and cross-site Fetch Metadata, while allowing explicit same-origin metadata", async () => {
    profile();
    const path = "/api/app/profiles/1/follow",
      body = { following: true, confirmed: true };
    expect(
      (await request(path, 2, "POST", body, { origin: null })).status
    ).toBe(403);
    expect(
      (
        await request(path, 2, "POST", body, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status
    ).toBe(403);
    expect(
      (await request(path, 2, "POST", body, { origin: "not a url" })).status
    ).toBe(403);
    expect(
      (
        await request(path, 2, "POST", body, {
          origin: null,
          headers: { "Sec-Fetch-Site": "same-origin" },
        })
      ).status
    ).toBe(200);
  });
  it("rejects malformed IDs and invalid types without coercion or profile creation", async () => {
    profile();
    post();
    for (const id of ["0", "-1", "01", "NaN", "1.5", "9007199254740992"])
      expect((await request(`/api/app/profiles/${id}/social`, 2)).status).toBe(
        400
      );
    for (const following of ["true", 1, null, [], {}])
      expect(
        (
          await request("/api/app/profiles/1/follow", 2, "POST", {
            following,
            confirmed: true,
          })
        ).status
      ).toBe(400);
    for (const body of [null, [], "text", { confirmed: true }]) {
      expect(
        (await request("/api/app/posts/post-one/reaction", 2, "POST", body))
          .status
      ).toBe(400);
      expect(
        (await request("/api/app/posts/post-one/comments", 2, "POST", body))
          .status
      ).toBe(400);
    }
    expect(
      (await request(`/api/app/posts/${"a".repeat(192)}/social`)).status
    ).toBe(400);
    expect(rows("follow")).toHaveLength(0);
    expect(rows("post-reaction")).toHaveLength(0);
  });
});

describe("durable following, visibility, and truthful optional counts", () => {
  it("requires an existing visible profile, never writes on reads, and reports zero rather than fake people", async () => {
    expect((await request("/api/app/profiles/1/social")).status).toBe(404);
    expect(fake.records.size).toBe(0);
    profile();
    const result = await request("/api/app/profiles/1/social");
    expect(result.data).toEqual({
      following: false,
      canFollow: false,
      followers: 0,
      followingCount: 0,
    });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(fake.records.size).toBe(1);
    expect(
      (await request("/api/app/profiles/1/social", 2)).data.canFollow
    ).toBe(true);
    expect(
      (await request("/api/app/profiles/1/social", 1)).data.canFollow
    ).toBe(false);
  });
  it("uses shared profile visibility for public/member/private views, independently of discoverability", async () => {
    const value = profile(1, { visibility: "members", discoverable: false });
    expect((await request("/api/app/profiles/1/social")).status).toBe(404);
    expect((await request("/api/app/profiles/1/social", 2)).status).toBe(200);
    expect((await follow(2)).status).toBe(200);
    value.settings.visibility = "private";
    expect((await request("/api/app/profiles/1/social", 2)).status).toBe(404);
    expect((await follow(3)).status).toBe(404);
    expect(
      (await request("/api/app/profiles/1/social", 1)).data.followers
    ).toBe(1);
    value.settings.visibility = "public";
    expect((await request("/api/app/profiles/1/social")).status).toBe(200);
  });
  it("sets follow state idempotently, returns real follower/following counts, and rejects self-follow", async () => {
    profile(1);
    profile(2);
    profile(3);
    expect((await follow(1)).status).toBe(400);
    expect((await follow(2)).data).toEqual({
      following: true,
      canFollow: true,
      followers: 1,
      followingCount: 0,
    });
    await follow(2);
    await follow(3);
    await follow(1, true, 3);
    expect(
      rows("follow")
        .map(row => row.id)
        .sort()
    ).toEqual(["follow:1:3", "follow:2:1", "follow:3:1"]);
    expect((await request("/api/app/profiles/1/social", 2)).data).toEqual({
      following: true,
      canFollow: true,
      followers: 2,
      followingCount: 1,
    });
    await follow(2, false);
    const repeated = await follow(2, false);
    expect(repeated.data).toEqual({
      following: false,
      canFollow: true,
      followers: 1,
      followingCount: 1,
    });
    expect(rows("follow")).toHaveLength(3);
    expect(rows("follow").find(row => row.id === "follow:2:1").following).toBe(
      false
    );
  });
  it("hides both counts when requested except from the owner and enforces allowFollow", async () => {
    const value = profile(1, { showFollowerCount: false });
    await follow(2);
    expect((await request("/api/app/profiles/1/social", 2)).data).toEqual({
      following: true,
      canFollow: true,
    });
    expect((await request("/api/app/profiles/1/social")).data).toEqual({
      following: false,
      canFollow: false,
    });
    expect((await request("/api/app/profiles/1/social", 1)).data).toEqual({
      following: false,
      canFollow: false,
      followers: 1,
      followingCount: 0,
    });
    value.settings.allowFollow = false;
    expect((await follow(3)).status).toBe(403);
    expect((await request("/api/app/profiles/1/social", 2)).data).toEqual({
      following: true,
      canFollow: false,
    });
    expect((await follow(2, false)).data).toEqual({
      following: false,
      canFollow: false,
    });
  });
  it("always revokes an existing follow after target privacy/permissions/deletion changes without leaking counts", async () => {
    const value = profile();
    await follow(2);
    value.settings.visibility = "private";
    value.settings.allowFollow = false;
    expect((await follow(2, false)).data).toEqual({
      following: false,
      canFollow: false,
    });
    expect(fake.records.get("follow/follow:2:1").following).toBe(false);
    value.settings.visibility = "public";
    value.settings.allowFollow = true;
    await follow(2);
    fake.records.delete("profile/profile:1");
    expect((await follow(2, false)).data).toEqual({
      following: false,
      canFollow: false,
    });
    expect(fake.records.get("follow/follow:2:1").following).toBe(false);
    const count = fake.records.size;
    expect((await follow(3, false, 98765)).data).toEqual({
      following: false,
      canFollow: false,
    });
    expect(fake.records.size).toBe(count);
    expect((await follow(3, true, 98765)).status).toBe(404);
  });
  it("keeps a single row on simultaneous first follows and counts each different actor once", async () => {
    profile();
    let release!: () => void;
    fake.createGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const pending = Array.from({ length: 16 }, () => follow(2));
    await vi.waitFor(() => expect(fake.pendingCreates).toBe(16));
    release();
    const results = await Promise.all(pending);
    fake.createGate = undefined;
    expect(results.map(result => result.status)).toEqual(Array(16).fill(200));
    expect(fake.duplicateCreates).toBe(15);
    expect(rows("follow")).toHaveLength(1);
    expect(
      (await request("/api/app/profiles/1/social", 2)).data.followers
    ).toBe(1);
    const more = await Promise.all(
      Array.from({ length: 12 }, (_, i) => follow(i + 10))
    );
    expect(more.every(result => result.status === 200)).toBe(true);
    expect((await request("/api/app/profiles/1/social")).data.followers).toBe(
      13
    );
    await Promise.all(Array.from({ length: 12 }, () => follow(2, false)));
    expect(
      (await request("/api/app/profiles/1/social", 2)).data.followers
    ).toBe(12);
  });
  it("rechecks follow permission before row mutation and hides privacy/count changes during aggregation", async () => {
    const value = profile();
    let reads = 0;
    fake.getHook = kind => {
      if (kind === "profile" && ++reads === 2)
        value.settings.allowFollow = false;
    };
    expect((await follow(2)).status).toBe(403);
    expect(rows("follow").some(row => row.following)).toBe(false);
    fake.getHook = undefined;
    fake.listHook = kind => {
      if (kind === "follow") value.settings.showFollowerCount = false;
    };
    expect((await request("/api/app/profiles/1/social", 2)).data).toEqual({
      following: false,
      canFollow: false,
    });
    value.settings.showFollowerCount = true;
    fake.listHook = kind => {
      if (kind === "follow") value.settings.visibility = "private";
    };
    const hidden = await request("/api/app/profiles/1/social", 2);
    expect(hidden.status).toBe(404);
    expect(hidden.data).toEqual({ error: "Profile not found" });
  });
  it("retries bounded transaction rollbacks and does not hide unrelated database failures", async () => {
    profile();
    fake.mutationFailures = ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"];
    expect((await follow(2)).status).toBe(200);
    expect(fake.mutationAttempts).toBe(3);
    expect(rows("follow")).toHaveLength(1);
    fake.mutationFailures = [
      "ER_LOCK_DEADLOCK",
      "ER_LOCK_DEADLOCK",
      "ER_LOCK_DEADLOCK",
    ];
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await follow(3)).status).toBe(500);
    expect(rows("follow").filter(row => row.following)).toHaveLength(1);
    fake.mutationFailures = ["ER_NO_SUCH_TABLE"];
    const before = fake.mutationAttempts;
    expect((await follow(4)).status).toBe(500);
    expect(fake.mutationAttempts - before).toBe(1);
    log.mockRestore();
  });
});

describe("post social summaries and single-actor reactions", () => {
  it("defaults missing owner profiles to allowing comments/reactions, with honest logged-out capability flags", async () => {
    post();
    expect((await request("/api/app/posts/post-one/social")).data).toEqual({
      reactions: [],
      myReaction: null,
      commentsCount: 0,
      canComment: false,
      canReact: false,
    });
    expect((await request("/api/app/posts/post-one/social", 2)).data).toEqual({
      reactions: [],
      myReaction: null,
      commentsCount: 0,
      canComment: true,
      canReact: true,
    });
    expect((await reaction(2)).status).toBe(200);
    expect((await comment(102)).status).toBe(201);
    expect(rows("profile")).toEqual([]);
  });
  it("accepts exactly the shared eight emoji, rejects arbitrary input, and sets rather than toggles on retries", async () => {
    post();
    for (const emoji of REACTION_EMOJIS)
      expect((await reaction(2, emoji)).status).toBe(200);
    expect(REACTION_EMOJIS).toHaveLength(8);
    for (const emoji of ["👍", "❤", "", "🔥🔥", 5, [], {}, false])
      expect((await reaction(2, emoji)).status).toBe(400);
    await reaction(2, "🔥");
    expect((await reaction(2, "🔥")).data).toEqual({
      reactions: [{ emoji: "🔥", count: 1 }],
      myReaction: "🔥",
      commentsCount: 0,
      canComment: true,
      canReact: true,
    });
    await reaction(3, "🔥");
    expect((await reaction(2, "❤️")).data.reactions).toEqual([
      { emoji: "🔥", count: 1 },
      { emoji: "❤️", count: 1 },
    ]);
    expect(rows("post-reaction")).toHaveLength(2);
    expect(
      (await request("/api/app/posts/post-one/social")).data.myReaction
    ).toBeNull();
    expect((await reaction(2, null)).data.myReaction).toBeNull();
    expect((await reaction(2, null)).data.reactions).toEqual([
      { emoji: "🔥", count: 1 },
    ]);
    const before = rows("post-reaction").length;
    await reaction(4, null);
    expect(rows("post-reaction")).toHaveLength(before);
  });
  it("uses the post owner's live settings, not the actor's, and still permits null removal when disabled", async () => {
    post();
    const owner = profile(1, { visibility: "private" });
    profile(2, { allowComments: false, allowReactions: false });
    expect((await reaction(2)).status).toBe(200);
    owner.settings.allowReactions = false;
    owner.settings.allowComments = false;
    const summary = await request("/api/app/posts/post-one/social", 2);
    expect(summary.status).toBe(200);
    expect(summary.data).toMatchObject({
      canReact: false,
      canComment: false,
      myReaction: "🔥",
    });
    expect((await reaction(2, "🚀")).status).toBe(403);
    expect((await reaction(1, "🚀")).status).toBe(403);
    expect((await comment(103)).status).toBe(403);
    expect((await comment(1)).status).toBe(403);
    expect((await reaction(2, null)).data).toMatchObject({
      myReaction: null,
      reactions: [],
      canReact: false,
    });
    owner.settings.allowReactions = true;
    owner.settings.allowComments = true;
    expect((await reaction(2)).status).toBe(200);
    expect((await comment(103)).status).toBe(201);
  });
  it("is duplicate-safe for concurrent initial reactions and row-locked replacements", async () => {
    post();
    let release!: () => void;
    fake.createGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const pending = Array.from({ length: 16 }, () => reaction(2));
    await vi.waitFor(() => expect(fake.pendingCreates).toBe(16));
    release();
    const results = await Promise.all(pending);
    fake.createGate = undefined;
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(fake.duplicateCreates).toBe(15);
    expect(rows("post-reaction")).toHaveLength(1);
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => reaction(i + 10, "🎮"))
    );
    const summary = (await request("/api/app/posts/post-one/social", 2)).data;
    expect(summary.reactions).toEqual([
      { emoji: "🎮", count: 16 },
      { emoji: "🔥", count: 1 },
    ]);
    await Promise.all(
      Array.from({ length: 16 }, (_, i) => reaction(2, REACTION_EMOJIS[i % 8]))
    );
    await reaction(2, "💯");
    expect(rows("post-reaction")).toHaveLength(17);
    expect(
      (await request("/api/app/posts/post-one/social", 2)).data.reactions
    ).toEqual([
      { emoji: "🎮", count: 16 },
      { emoji: "💯", count: 1 },
    ]);
  });
  it("bounds per-actor in-flight writes without blocking other actors and releases slots after completion", async () => {
    post();
    let release!: () => void;
    fake.createGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const pending = Array.from({ length: 32 }, () => reaction(2));
    await vi.waitFor(() => expect(fake.pendingCreates).toBe(32));
    expect((await reaction(2)).status).toBe(429);
    const other = reaction(3);
    await vi.waitFor(() => expect(fake.pendingCreates).toBe(33));
    release();
    expect((await other).status).toBe(200);
    expect(
      (await Promise.all(pending)).every(result => result.status === 200)
    ).toBe(true);
    fake.createGate = undefined;
    expect((await reaction(2)).status).toBe(200);
    expect(rows("post-reaction")).toHaveLength(2);
  });
  it("keeps long opaque post IDs inside the durable record ID limit and isolates each post", async () => {
    const longId = "x".repeat(191);
    post(longId);
    post();
    expect((await reaction(2, "🚀", longId)).status).toBe(200);
    expect(rows("post-reaction")[0].id.length).toBeLessThanOrEqual(191);
    expect(
      (await request("/api/app/posts/post-one/social", 2)).data.reactions
    ).toEqual([]);
    expect(
      (await request(`/api/app/posts/${longId}/social`, 2)).data.myReaction
    ).toBe("🚀");
  });
});

describe("post comments, ownership, and bounded spam protection", () => {
  it("stores trimmed plain text, uses authenticated names, and returns exactly the documented comment DTO", async () => {
    post();
    const text = '<script>alert("not HTML")</script> & <b>plain text</b>';
    const result = await comment(104, `  ${text}\n `);
    expect(result.status).toBe(201);
    expect(result.data).toEqual({
      id: expect.any(String),
      postId: "post-one",
      ownerId: 104,
      ownerName: "Authenticated member 104",
      text,
      createdAt: expect.any(String),
      canDelete: true,
    });
    expect(rows("post-comment")[0].text).toBe(text);
    expect((await request("/api/app/posts/post-one/comments")).data).toEqual([
      { ...result.data, canDelete: false },
    ]);
    expect(
      (await request("/api/app/posts/post-one/comments", 1)).data[0].canDelete
    ).toBe(true);
    expect(
      (await request("/api/app/posts/post-one/comments", 105)).data[0].canDelete
    ).toBe(false);
    expect(
      (await request("/api/app/posts/post-one/social", 104)).data.commentsCount
    ).toBe(1);
    expect(
      (
        await request("/api/app/posts/post-one/comments", 104, "POST", {
          text: "forged",
          ownerName: "Fake admin",
          confirmed: true,
        })
      ).status
    ).toBe(400);
  });
  it("enforces nonempty 1..1000 character text without HTML interpretation", async () => {
    post();
    expect((await comment(106, "x".repeat(1000))).status).toBe(201);
    for (const text of ["", " \n\t ", "x".repeat(1001), "bad\u0000text"])
      expect((await comment(106, text)).status).toBe(400);
    expect(
      (
        await request("/api/app/posts/post-one/comments", 106, "POST", {
          text: 12,
          confirmed: true,
        })
      ).status
    ).toBe(400);
    expect((await comment(106, "first\nsecond\tthird")).data.text).toBe(
      "first\nsecond\tthird"
    );
  });
  it("returns only the latest 50 ascending comments and counts all undeleted comments for the selected post", async () => {
    post();
    for (let i = 0; i < 65; i++)
      seededComment(`c-${String(i).padStart(3, "0")}`, 2, {
        text: `text ${i}`,
        createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      });
    seededComment("deleted", 2, { deletedAt: new Date().toISOString() });
    seededComment("other", 2, { postId: "other-post" });
    const result = await request("/api/app/posts/post-one/comments", 2);
    expect(result.data).toHaveLength(50);
    expect(result.data[0].id).toBe("c-015");
    expect(result.data[49].id).toBe("c-064");
    expect(result.data.every((row: any) => row.canDelete)).toBe(true);
    expect(result.data.some((row: any) => "deletedAt" in row)).toBe(false);
    expect(
      (await request("/api/app/posts/post-one/social")).data.commentsCount
    ).toBe(65);
  });
  it("allows only author or post owner to soft-delete, scopes IDs to the post, and permits deletion while comments are disabled", async () => {
    post();
    post("other-post", 3);
    const value = profile();
    const first = (await comment(107)).data;
    const second = (await comment(108)).data;
    value.settings.allowComments = false;
    expect((await removeComment(first.id, 3)).status).toBe(403);
    expect((await removeComment(first.id, 3, "other-post")).status).toBe(404);
    expect(
      fake.records.get(`post-comment/${first.id}`).deletedAt
    ).toBeUndefined();
    expect((await removeComment(first.id, 107)).data).toEqual({
      deleted: true,
    });
    expect((await removeComment(first.id, 107)).data).toEqual({
      deleted: true,
    });
    expect(fake.records.get(`post-comment/${first.id}`).deletedAt).toBeTruthy();
    expect(
      (await request("/api/app/posts/post-one/comments", 1)).data.map(
        (row: any) => row.id
      )
    ).toEqual([second.id]);
    expect(
      (await request("/api/app/posts/post-one/social", 1)).data.commentsCount
    ).toBe(1);
    expect((await removeComment(second.id, 1)).data).toEqual({ deleted: true });
    expect((await request("/api/app/posts/post-one/comments", 1)).data).toEqual(
      []
    );
    expect((await removeComment("missing", 1)).status).toBe(404);
  });
  it("persists concurrent comments without lost records and makes concurrent deletion idempotent", async () => {
    post();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => comment(109, `comment ${i}`))
    );
    expect(responses.every(result => result.status === 201)).toBe(true);
    expect(new Set(responses.map(result => result.data.id)).size).toBe(8);
    const id = responses[0].data.id;
    const deleted = await Promise.all(
      Array.from({ length: 8 }, () => removeComment(id, 1))
    );
    expect(deleted.every(result => result.status === 200)).toBe(true);
    expect(
      (await request("/api/app/posts/post-one/social")).data.commentsCount
    ).toBe(7);
  });
  it("throttles bursts per actor across posts, recovers after a minute, and does not charge failed persistence", async () => {
    post();
    post("other-post");
    for (let i = 0; i < 8; i++)
      expect(
        (await comment(110, `message ${i}`, i % 2 ? "other-post" : "post-one"))
          .status
      ).toBe(201);
    expect((await comment(110)).status).toBe(429);
    expect((await comment(111)).status).toBe(201);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    expect((await comment(110)).status).toBe(201);
    clock.mockRestore();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.createFailure = "ER_NO_SUCH_TABLE";
    for (let i = 0; i < 9; i++) expect((await comment(112)).status).toBe(500);
    fake.createFailure = undefined;
    expect((await comment(112)).status).toBe(201);
    log.mockRestore();
  });
});

describe("live post ACL gates every social read and write without private-audience leaks", () => {
  it("denies all endpoints before inspecting private comments/reactions for logged-out and nonmember viewers", async () => {
    post("post-one", 1, [1, 2]);
    seededComment("private-comment");
    fake.records.set("post-reaction/private-reaction", {
      id: "private-reaction",
      ownerId: 2,
      postId: "post-one",
      emoji: "🔥",
    });
    for (const userId of [undefined, 3]) {
      for (const endpoint of ["social", "comments"]) {
        const result = await request(
          `/api/app/posts/post-one/${endpoint}`,
          userId
        );
        expect(result.status).toBe(404);
        expect(result.data).toEqual({ error: "Post not found" });
      }
    }
    expect(fake.listCalls).toEqual([]);
    for (const [path, method, input] of [
      ["/api/app/posts/post-one/reaction", "POST", { emoji: "🔥" }],
      ["/api/app/posts/post-one/reaction", "POST", { emoji: null }],
      ["/api/app/posts/post-one/comments", "POST", { text: "private probe" }],
      ["/api/app/posts/post-one/comments/private-comment", "DELETE", {}],
    ] as [string, string, object][]) {
      const result = await request(path, 3, method, {
        ...input,
        confirmed: true,
      });
      expect(result.status).toBe(404);
      expect(JSON.stringify(result.data)).not.toMatch(
        /PRIVATE|Member|followers|commentsCount|reactions/
      );
    }
    expect(rows("post-comment")[0].deletedAt).toBeUndefined();
    expect(
      (await request("/api/app/posts/post-one/comments", 2)).data
    ).toHaveLength(1);
  });
  it("revokes author access along with live post membership for reads, null removal, comments, and deletion", async () => {
    const value = post("post-one", 1, [1, 2]);
    await reaction(2);
    const created = (await comment(2)).data;
    value.members = [1];
    expect((await request("/api/app/posts/post-one/social", 2)).status).toBe(
      404
    );
    expect((await request("/api/app/posts/post-one/comments", 2)).status).toBe(
      404
    );
    expect((await reaction(2, null)).status).toBe(404);
    expect((await comment(2)).status).toBe(404);
    expect((await removeComment(created.id, 2)).status).toBe(404);
    expect(rows("post-reaction")[0].emoji).toBe("🔥");
    expect(rows("post-comment")[0].deletedAt).toBeUndefined();
    value.deleted = true;
    expect((await request("/api/app/posts/post-one/social", 1)).status).toBe(
      404
    );
    expect((await removeComment(created.id, 1)).status).toBe(404);
    expect((await request("/api/app/posts/missing/social", 1)).status).toBe(
      404
    );
  });
  it("rechecks ACL after aggregation so privacy changes during reads cannot leak any summary or comments", async () => {
    const value = post("post-one", 1, [1, 2]);
    seededComment("secret");
    fake.listHook = kind => {
      if (kind === "post-reaction") value.members = [1];
    };
    const summary = await request("/api/app/posts/post-one/social", 2);
    expect(summary.status).toBe(404);
    expect(summary.data).toEqual({ error: "Post not found" });
    value.members = [1, 2];
    fake.listHook = kind => {
      if (kind === "post-comment") value.deleted = true;
    };
    const comments = await request("/api/app/posts/post-one/comments", 2);
    expect(comments.status).toBe(404);
    expect(comments.data).toEqual({ error: "Post not found" });
  });
  it("does not leak post aggregates if live access is revoked while reading owner profile permissions", async () => {
    const value = post("post-one", 1, [1, 2]);
    profile();
    seededComment("secret");
    fake.getHook = kind => {
      if (kind === "profile") value.members = [1];
    };
    const result = await request("/api/app/posts/post-one/social", 2);
    expect(result.status).toBe(404);
    expect(result.data).toEqual({ error: "Post not found" });
  });
  it("rechecks post ACL and settings after inert reaction row creation and before returning created comments", async () => {
    const value = post("post-one", 1, [1, 2]);
    const owner = profile();
    fake.createHook = kind => {
      if (kind === "post-reaction") owner.settings.allowReactions = false;
    };
    expect((await reaction(2)).status).toBe(403);
    expect(rows("post-reaction")[0].emoji).toBeNull();
    fake.createHook = kind => {
      if (kind === "post-comment") value.members = [1];
    };
    const result = await comment(2);
    expect(result.status).toBe(404);
    expect(result.data).toEqual({ error: "Post not found" });
    expect((await request("/api/app/posts/post-one/comments", 2)).status).toBe(
      404
    );
  });
});
