import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import { createServer, type Server } from "node:http";
import type { User } from "../drizzle/schema";
import {
  defaultPreferences,
  type Clip,
  type Source,
  type Squad,
} from "../shared/app-types";

// All identity/records below are test-only fixtures behind mocks. No database
// connection, user creation, media processing, or production AI call occurs.
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  createClip: vi.fn(),
  updateClip: vi.fn(),
  canReadSource: vi.fn(),
  canReadClip: vi.fn(),
  needUser: vi.fn(),
  invokeLLM: vi.fn(),
  listLLMModels: vi.fn(),
}));
vi.mock("./features/store", () => ({ get: mocks.get, list: mocks.list }));
vi.mock("./features/media", () => ({
  createClip: mocks.createClip,
  updateClip: mocks.updateClip,
}));
vi.mock("./_core/llm", () => ({
  invokeLLM: mocks.invokeLLM,
  listLLMModels: mocks.listLLMModels,
}));
vi.mock("./features/access", async () => {
  const actual =
    await vi.importActual<typeof import("./features/access")>(
      "./features/access"
    );
  return {
    ...actual,
    canReadSource: mocks.canReadSource,
    canReadClip: mocks.canReadClip,
    needUser: mocks.needUser,
  };
});
import {
  checkSidekickOrigin,
  matchSquads,
  registerSidekickRoutes,
  relativeCaptions,
  runSidekick,
  SIDEKICK_MODEL,
} from "./features/sidekick";

const user = { id: 41, name: "Unit test member" } as User;
const source: Source = {
  id: "source-fixture",
  creatorId: 41,
  creatorName: "Unit test member",
  title: "Uploaded test footage",
  game: "Test Game",
  kind: "upload",
  audience: "public",
  allowClip: "everyone",
  allowPublish: true,
  allowDownload: true,
  duration: 400,
  status: "ready",
  createdAt: "2026-11-18T12:00:00Z",
  transcript: [],
};
const clip: Clip = {
  id: "clip-fixture",
  ownerId: 41,
  ownerName: "Unit test member",
  sourceId: source.id,
  creatorId: 41,
  creatorName: "Unit test member",
  title: "Draft",
  game: "Test Game",
  start: 100,
  end: 130,
  crop: "original",
  cropX: 0.5,
  cropY: 0.5,
  captions: [],
  overlay: "",
  audience: "public",
  status: "queued",
  published: false,
  createdAt: "2026-11-18T12:00:00Z",
};
const now = Date.parse("2026-11-18T15:00:00Z");
function squad(id: string, changes: Partial<Squad> = {}): Squad {
  return {
    id,
    ownerId: 42,
    ownerName: "Test-only owner",
    title: "Test-only squad",
    game: "Test Game",
    platform: "PC",
    mic: "optional",
    startsAt: "2026-11-18T16:00:00Z",
    expiresAt: "2026-11-18T19:00:00Z",
    capacity: 4,
    members: [42],
    requests: [],
    vibe: "Chill",
    createdAt: "2026-11-18T14:00:00Z",
    ...changes,
  };
}
function ai(message: string, requiresConfirmation = false) {
  return {
    choices: [
      {
        message: { content: JSON.stringify({ message, requiresConfirmation }) },
        finish_reason: "stop",
      },
    ],
  };
}
function records(
  changes: {
    source?: Partial<Source>;
    clip?: Partial<Clip>;
    preferences?: Record<string, unknown>;
    studio?: Record<string, unknown>;
  } = {}
) {
  mocks.get.mockImplementation(async (kind: string, id: string) => {
    if (kind === "preferences" && id === `preferences:${user.id}`)
      return { ...defaultPreferences, ...changes.preferences };
    if (kind === "source" && id === source.id)
      return { ...source, ...changes.source };
    if (kind === "clip" && id === clip.id) return { ...clip, ...changes.clip };
    if (kind === "studio" && id === `studio:${user.id}`) return changes.studio;
    return undefined;
  });
}
let servers: Server[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MANUS_API_KEY", "");
  vi.stubEnv("MANUS_API_URL", "");
  vi.stubEnv("RESPAWN_CF_TOKEN", "");
  vi.stubEnv("RESPAWN_CF_ACCOUNT_ID", "");
  records();
  mocks.list.mockResolvedValue([]);
  mocks.canReadSource.mockResolvedValue(true);
  mocks.canReadClip.mockResolvedValue(true);
  mocks.needUser.mockResolvedValue(user);
  mocks.createClip.mockResolvedValue(clip);
  mocks.updateClip.mockImplementation(async (_user, _id, changes) => ({
    ...clip,
    ...changes,
  }));
  mocks.listLLMModels.mockResolvedValue({ data: [{ id: SIDEKICK_MODEL }] });
  mocks.invokeLLM.mockResolvedValue(
    ai("I can help with your available app tools.")
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.map(
      server =>
        new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
    )
  );
  servers = [];
});
async function http() {
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  registerSidekickRoutes(app);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    post: (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}/api/sidekick`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: url,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
  };
}

describe("Sidekick permission, input, and consent boundary", () => {
  it("rejects unauthenticated requests before fetching context or calling AI", async () => {
    mocks.needUser.mockRejectedValue(
      Object.assign(new Error("Please sign in"), { status: 401 })
    );
    const { post } = await http();
    const response = await post({ message: "hello" });
    expect(response.status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });
  it("rejects cross-site writes before authentication", async () => {
    const { post } = await http();
    const response = await post(
      { message: "clip that" },
      { origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" }
    );
    expect(response.status).toBe(403);
    expect(mocks.needUser).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("rejects same-site browser requests as well", () => {
    const req = {
      method: "POST",
      get: (name: string) =>
        name === "sec-fetch-site" ? "same-site" : undefined,
    } as Request;
    expect(() => checkSidekickOrigin(req)).toThrow("Same-origin");
  });
  it("honors assistant opt-out before retrieving source context", async () => {
    records({ preferences: { enabled: false } });
    await expect(
      runSidekick(user, {
        message: "clip that",
        sourceId: source.id,
        position: 20,
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.get.mock.calls).toHaveLength(1);
    expect(mocks.createClip).not.toHaveBeenCalled();
  });
  it("denies inaccessible source before chat lookup and AI", async () => {
    mocks.canReadSource.mockResolvedValue(false);
    await expect(
      runSidekick(user, {
        message: "catch up",
        sourceId: source.id,
        position: 20,
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });
  it("denies inaccessible clips and mismatched source context", async () => {
    mocks.canReadClip.mockResolvedValue(false);
    await expect(
      runSidekick(user, { message: "vertical", clipId: clip.id })
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.canReadSource).not.toHaveBeenCalled();
    mocks.canReadClip.mockResolvedValue(true);
    await expect(
      runSidekick(user, {
        message: "vertical",
        clipId: clip.id,
        sourceId: "other",
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(mocks.updateClip).not.toHaveBeenCalled();
  });
  it.each([
    { message: "", sourceId: source.id },
    { message: "x".repeat(2001) },
    { message: "hello", position: -1 },
    { message: "hello", position: Infinity },
    { message: "hello", userId: 1 },
  ])(
    "validates bounded inputs and rejects identity injection: %j",
    async body => {
      await expect(runSidekick(user, body)).rejects.toMatchObject({
        status: 400,
      });
      expect(mocks.get).not.toHaveBeenCalled();
    }
  );
  it("rejects oversized payloads before fetching any records", async () => {
    await expect(
      runSidekick(user, { message: "x".repeat(5000) })
    ).rejects.toMatchObject({ status: 413 });
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it("does not mutate personalization from chat requests", async () => {
    const result = await runSidekick(user, {
      message: "remember my preference for Test Game",
    });
    expect(result.message).toMatch(/not saved or inferred/);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(mocks.updateClip).not.toHaveBeenCalled();
  });
});

describe("deterministic clip and real editable caption draft", () => {
  it("uses the identical media helper and saved duration when AI is offline", async () => {
    records({ preferences: { clipDuration: 60, personalization: false } });
    const result = await runSidekick(user, {
      message: "Clip that",
      sourceId: source.id,
      position: 12,
    });
    expect(mocks.createClip).toHaveBeenCalledWith(user, {
      sourceId: source.id,
      position: 12,
      duration: 60,
    });
    expect(result.action).toBe("clip");
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });
  it("preserves honest live bookmark status and never substitutes wall time", async () => {
    records({ source: { kind: "live", status: "live", duration: 0 } });
    mocks.createClip.mockResolvedValue({
      ...clip,
      status: "bookmarked",
      footageNote: "Replay is not available yet.",
    });
    const result = await runSidekick(user, {
      message: "clip that",
      sourceId: source.id,
      position: 87,
    });
    expect(result.clip?.status).toBe("bookmarked");
    expect(result.message).toMatch(/Moment bookmarked/);
    expect(mocks.createClip).toHaveBeenCalledWith(user, {
      sourceId: source.id,
      position: 87,
      duration: 30,
    });
    await expect(
      runSidekick(user, { message: "clip that", sourceId: source.id })
    ).rejects.toMatchObject({ status: 400 });
  });
  it("forwards media permission denial rather than reporting a successful save", async () => {
    mocks.createClip.mockRejectedValue(
      Object.assign(new Error("Creator disallows clipping"), { status: 403 })
    );
    await expect(
      runSidekick(user, {
        message: "clip that",
        sourceId: source.id,
        position: 30,
      })
    ).rejects.toMatchObject({ status: 403 });
  });
  it("strips internal storage fields from returned clips", async () => {
    mocks.createClip.mockResolvedValue({
      ...clip,
      outputKey: "secret-storage-key",
      posterKey: "secret-poster",
      arbitrarySecret: "never leak",
    });
    const result = await runSidekick(user, {
      message: "clip that",
      sourceId: source.id,
      position: 30,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret-storage|secret-poster|arbitrarySecret/
    );
  });
  it("clips and shifts actual transcript captions to the draft interval", async () => {
    records({
      source: {
        transcript: [
          { start: 90, end: 101, text: "Before boundary" },
          { start: 110, end: 115, text: "Actual words" },
          { start: 129, end: 135, text: "After boundary" },
          { start: 150, end: 155, text: "Outside" },
        ],
      },
    });
    const result = await runSidekick(user, {
      message: "make vertical with captions",
      clipId: clip.id,
    });
    expect(mocks.updateClip).toHaveBeenCalledWith(user, clip.id, {
      crop: "vertical",
      captions: [
        { start: 0, end: 1, text: "Before boundary" },
        { start: 10, end: 15, text: "Actual words" },
        { start: 29, end: 30, text: "After boundary" },
      ],
    });
    expect(result.message).toMatch(/actual source transcript/);
    expect(result.message).toMatch(/Nothing was published/);
  });
  it("never invents missing captions or overwrites real existing editable ones", async () => {
    records({
      clip: {
        captions: [
          { start: 0, end: 5, text: "Manually entered actual caption" },
        ],
      },
    });
    const result = await runSidekick(user, {
      message: "vertical",
      clipId: clip.id,
    });
    expect(mocks.updateClip).toHaveBeenCalledWith(user, clip.id, {
      crop: "vertical",
    });
    expect(result.message).toMatch(/Existing captions were preserved/);
    records();
    const empty = await runSidekick(user, {
      message: "caption this",
      clipId: clip.id,
    });
    expect(empty.message).toMatch(/none were invented/);
  });
  it("prepares a viewer-owned vertical draft without generating missing captions or calling AI", async () => {
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    records({ source: { creatorId: 42 }, clip: { creatorId: 42 } });
    const result = await runSidekick(user, {
      message: "make vertical with captions",
      clipId: clip.id,
    });
    expect(result.action).toBe("edit");
    expect(mocks.updateClip).toHaveBeenCalledTimes(1);
    expect(mocks.updateClip).toHaveBeenCalledWith(user, clip.id, {
      crop: "vertical",
    });
    expect(result.clip?.captions).toEqual([]);
    expect(result.basedOn).toBe("No caption evidence available");
    expect(result.message).toMatch(/Prepared your editable 9:16 vertical/);
    expect(result.message).toMatch(/Captions have not yet been generated/);
    expect(result.message).toMatch(
      /Use Generate captions in the editor and confirm transcription usage/
    );
    expect(result.message).toMatch(/add captions manually/);
    expect(result.message).toMatch(/Nothing was published/);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(mocks.createClip).not.toHaveBeenCalled();
  });
  it("only edits an owned unpublished clip", async () => {
    records({ clip: { ownerId: 42 } });
    await expect(
      runSidekick(user, { message: "vertical", clipId: clip.id })
    ).rejects.toMatchObject({ status: 403 });
    records({ clip: { published: true } });
    const result = await runSidekick(user, {
      message: "vertical",
      clipId: clip.id,
    });
    expect(result.requiresConfirmation).toBe(true);
    expect(mocks.updateClip).not.toHaveBeenCalled();
  });
  it("ignores malformed/outside transcript segments", () => {
    expect(
      relativeCaptions(
        [
          { start: NaN, end: 120, text: "bad" },
          { start: 101, end: 100, text: "bad" },
          { start: 100, end: 130, text: "actual" },
        ],
        clip
      )
    ).toEqual([{ start: 0, end: 30, text: "actual" }]);
  });
  it("bounds real caption text to the media update helper's accepted size", () => {
    expect(
      relativeCaptions(
        [{ start: 100, end: 110, text: "x".repeat(500) }],
        clip
      )[0].text
    ).toHaveLength(300);
  });
  it("optionally saves a real AI title into the editable draft without publication", async () => {
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    records({
      source: {
        transcript: [{ start: 105, end: 110, text: "Actual spoken words" }],
      },
    });
    mocks.invokeLLM.mockResolvedValue(ai("Actual words, great moment"));
    const result = await runSidekick(user, {
      message: "vertical",
      clipId: clip.id,
    });
    expect(mocks.updateClip).toHaveBeenNthCalledWith(2, user, clip.id, {
      title: "Actual words, great moment",
    });
    expect(result.message).toMatch(/AI title suggestion/);
    expect(result.message).toMatch(/correct it before posting/);
    expect(result.clip?.published).toBe(false);
  });
  it("keeps the deterministic vertical draft when optional AI title service fails", async () => {
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    records({
      source: {
        transcript: [{ start: 105, end: 110, text: "Actual spoken words" }],
      },
    });
    mocks.invokeLLM.mockRejectedValue(new Error("test-only service failure"));
    const result = await runSidekick(user, {
      message: "vertical",
      clipId: clip.id,
    });
    expect(result.action).toBe("edit");
    expect(result.message).toMatch(
      /AI title suggestions are currently unavailable/
    );
    expect(mocks.updateClip).toHaveBeenCalledTimes(1);
  });
});

describe("actual transcript search and timestamped catch-up", () => {
  it("returns multiple actual laugh cues, not fabricated timestamps", async () => {
    records({
      source: {
        transcript: [
          { start: 14, end: 16, text: "[laughter]" },
          { start: 14.5, end: 17, text: "laughing" },
          { start: 45, end: 48, text: "hahaha" },
          { start: 80, end: 83, text: "ordinary speech" },
        ],
      },
    });
    const result = await runSidekick(user, {
      message: "find the laugh",
      sourceId: source.id,
    });
    expect(result.moments?.map(moment => moment.position)).toEqual([14, 45]);
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });
  it("returns explicit unavailable evidence without hallucinating laughs", async () => {
    const result = await runSidekick(user, {
      message: "find laughs",
      sourceId: source.id,
    });
    expect(result.moments).toEqual([]);
    expect(result.message).toMatch(/no available transcript/);
  });
  it("only recaps the actual last three minutes at the viewed source position", async () => {
    records({
      source: {
        transcript: [
          { start: 10, end: 12, text: "Old" },
          { start: 110, end: 115, text: "In range" },
          { start: 310, end: 315, text: "Future" },
        ],
      },
    });
    mocks.list.mockResolvedValue([
      { sourceId: source.id, position: 150, text: "Actual chat" },
      {
        sourceId: "private-other",
        position: 151,
        text: "Private never included",
      },
      { sourceId: source.id, position: 301, text: "Future chat" },
    ]);
    const result = await runSidekick(user, {
      message: "catch up",
      sourceId: source.id,
      position: 300,
    });
    expect(result.moments).toEqual([
      { position: 150, text: "CHAT: Actual chat" },
    ]);
    expect(result.basedOn).toMatch(/CHAT ONLY/);
    expect(JSON.stringify(result)).not.toMatch(
      /Old|Future|Private never included/
    );
  });
  it("labels chat-only recaps and distinguishes quotes from video events", async () => {
    mocks.list.mockResolvedValue([
      { sourceId: source.id, position: 390, text: "we won" },
    ]);
    const result = await runSidekick(user, {
      message: "recap",
      sourceId: source.id,
      position: 400,
    });
    expect(result.message).toMatch(/CHAT ONLY/);
    expect(result.basedOn).toMatch(/not an audiovisual recap/);
    expect(result.moments?.[0].text).toBe("CHAT: we won");
  });
  it("requires the player timestamp for live catch-up and skips context reads", async () => {
    records({ source: { kind: "live", duration: 999, status: "live" } });
    const result = await runSidekick(user, {
      message: "recap",
      sourceId: source.id,
    });
    expect(result.message).toMatch(/actual source-relative position/);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("reports unavailable recap data honestly", async () => {
    const result = await runSidekick(user, {
      message: "catch up",
      sourceId: source.id,
      position: 200,
    });
    expect(result.moments).toEqual([]);
    expect(result.message).toMatch(/cannot recap unseen footage/);
  });
});

describe("real squad matching and Studio", () => {
  it("filters actual games/platform/mic/availability plus expiry and full capacity", () => {
    const records = [
      squad("yes"),
      squad("full", { capacity: 1 }),
      squad("expired", { expiresAt: new Date(now).toISOString() }),
      squad("game", { game: "Other" }),
      squad("platform", { platform: "Console" }),
      squad("mic", { mic: "required" }),
      squad("later", { startsAt: "2026-11-20T16:00:00Z" }),
    ];
    const result = matchSquads(
      records,
      {
        ...defaultPreferences,
        personalization: true,
        games: ["Test Game"],
        mic: "no-mic",
      },
      "find squads",
      now
    );
    expect(result.squads.map(s => s.id)).toEqual(["yes"]);
  });
  it("never uses unconsented saved defaults to personalize", () => {
    const result = matchSquads(
      [squad("pc"), squad("console", { platform: "Console", game: "Other" })],
      {
        ...defaultPreferences,
        personalization: false,
        games: ["Test Game"],
        platform: "PC",
        mic: "no-mic",
      },
      "find squads",
      now
    );
    expect(result.squads.map(s => s.id)).toEqual(["pc", "console"]);
    expect(result.note).toMatch(/Personalization is off/);
  });
  it("uses explicit per-request preferences without saving them", () => {
    const result = matchSquads(
      [squad("pc"), squad("console", { platform: "Console" })],
      defaultPreferences,
      "find Test Game squads on Console",
      now
    );
    expect(result.squads.map(s => s.id)).toEqual(["console"]);
  });
  it("does not fabricate suggestions when actual squad storage is empty", async () => {
    const result = await runSidekick(user, { message: "find squads" });
    expect(result.squads).toEqual([]);
    expect(result.message).toMatch(/no suggestions were fabricated/);
  });
  it("hides other squad join requests", async () => {
    mocks.list.mockResolvedValue([
      squad("requests", {
        expiresAt: "2099-11-18T19:00:00Z",
        startsAt: "2099-11-18T16:00:00Z",
        requests: [
          { userId: 99, name: "private requester", createdAt: "" },
          { userId: user.id, name: "own", createdAt: "" },
        ],
      }),
    ]);
    const result = await runSidekick(user, { message: "find squads" });
    expect(result.squads?.[0].requests.map(r => r.userId)).toEqual([user.id]);
  });
  it("reads only own Studio settings, redacts secrets, and reports live unavailable", async () => {
    records({
      studio: {
        title: "My actual stream",
        game: "Test Game",
        provider: "Cloudflare Stream",
        connected: false,
        scheduledAt: "2026-11-20T12:00Z",
        streamKey: "test-only-never-output",
        rtmpsUrl: "secret-destination",
      },
    });
    const result = await runSidekick(user, { message: "studio mic check" });
    expect(mocks.get).toHaveBeenCalledWith("studio", `studio:${user.id}`);
    expect(result.message).toMatch(/My actual stream/);
    expect(result.message).toMatch(/unavailable/);
    expect(result.message).toMatch(/cannot test your device/);
    expect(JSON.stringify(result)).not.toMatch(
      /test-only-never-output|secret-destination/
    );
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
  });
  it("rejects corrupt preferences or Studio records owned by a different account", async () => {
    records({ preferences: { ownerId: 99 } });
    await expect(runSidekick(user, { message: "hello" })).rejects.toMatchObject(
      { status: 403 }
    );
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    records({ studio: { ownerId: 99 } });
    await expect(
      runSidekick(user, { message: "studio" })
    ).rejects.toMatchObject({ status: 403 });
  });
  it("does not call an old connected Studio record live when the service is disconnected", async () => {
    records({
      studio: {
        connected: true,
        title: "Actual old saved settings",
        provider: "Cloudflare Stream",
        status: "live",
      },
    });
    const result = await runSidekick(user, { message: "studio" });
    expect(result.message).toMatch(/not connected \/ unavailable/);
    expect(result.message).not.toMatch(/saved input connected/);
  });
});

describe("hard confirmation and bounded real AI integration", () => {
  it.each([
    "publish my clip",
    "send a message",
    "join the squad",
    "start a broadcast",
    "go live",
    "buy credits",
    "share this clip",
    "approve membership",
  ])("never executes external actions: %s", async message => {
    const result = await runSidekick(user, { message, clipId: clip.id });
    expect(result.requiresConfirmation).toBe(true);
    expect(result.action).toBe("confirm");
    expect(mocks.invokeLLM).not.toHaveBeenCalled();
    expect(mocks.createClip).not.toHaveBeenCalled();
    expect(mocks.updateClip).not.toHaveBeenCalled();
  });
  it("returns explicit missing-service status for free chat", async () => {
    await expect(runSidekick(user, { message: "hello" })).rejects.toMatchObject(
      { status: 503, message: expect.stringContaining("not configured") }
    );
  });
  it("uses the available selected model and opted-in gaming context with no executing tools", async () => {
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    records({
      preferences: {
        personalization: true,
        name: "Saved assistant",
        avatar: "saved-avatar",
        tone: "Hype",
        accent: "saved-accent",
        games: ["Test Game"],
        platform: "Console",
        mic: "no-mic",
        availability: "Tomorrow",
      },
    });
    const result = await runSidekick(user, { message: "hello" });
    expect(result.message).toMatch(/help/);
    const params = mocks.invokeLLM.mock.calls[0][0];
    expect(params.model).toBe("gpt-5.5");
    expect(params.reasoning).toEqual({ effort: "none" });
    expect(params.tools).toBeUndefined();
    expect(JSON.parse(params.messages[1].content).assistant).toEqual({
      personalization: true,
      name: "Saved assistant",
      avatar: "saved-avatar",
      tone: "Hype",
      accent: "saved-accent",
      games: ["Test Game"],
      platform: "Console",
      mic: "no-mic",
      availability: "Tomorrow",
    });
  });
  it("always honors explicit assistant identity and presentation while excluding unconsented gaming preferences", async () => {
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    records({
      preferences: {
        personalization: false,
        name: "Selected assistant",
        avatar: "selected-avatar",
        tone: "Hype",
        accent: "selected-accent",
        games: ["private inferred game"],
        platform: "private platform",
        mic: "private mic",
        availability: "private availability",
      },
    });
    await runSidekick(user, { message: "hello" });
    const params = mocks.invokeLLM.mock.calls[0][0];
    expect(JSON.parse(params.messages[1].content).assistant).toEqual({
      personalization: false,
      name: "Selected assistant",
      avatar: "selected-avatar",
      tone: "Hype",
      accent: "selected-accent",
    });
    expect(params.messages[1].content).not.toMatch(
      /private inferred game|private platform|private mic|private availability/
    );
    expect(params.messages[0].content).toMatch(
      /Always respect the explicitly selected assistant identity\/tone, even when gaming personalization is off/
    );
    expect(params.tools).toBeUndefined();
    expect(mocks.updateClip).not.toHaveBeenCalled();
  });
  it("does not reveal raw AI provider errors or secrets", async () => {
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    mocks.invokeLLM.mockRejectedValue(
      new Error("Bearer secret-provider-token and internal trace")
    );
    await expect(runSidekick(user, { message: "hello" })).rejects.toMatchObject(
      {
        status: 503,
        message: expect.not.stringMatching(/secret-provider-token|trace/),
      }
    );
  });
  it("rejects unusable JSON and gates false action-completion claims", async () => {
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    mocks.invokeLLM.mockResolvedValue({
      choices: [{ message: { content: "not json" } }],
    });
    await expect(runSidekick(user, { message: "hello" })).rejects.toMatchObject(
      { status: 503 }
    );
    mocks.invokeLLM.mockResolvedValue(ai("I have published your clip.", false));
    const result = await runSidekick(user, { message: "hello" });
    expect(result.requiresConfirmation).toBe(true);
    expect(result.message).toMatch(/Nothing has been/);
  });
  it("bounded AI deadline retains occupancy until underlying helper finishes", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MANUS_API_KEY", "test-only");
    vi.stubEnv("MANUS_API_URL", "https://service.invalid");
    let finish!: (value: ReturnType<typeof ai>) => void;
    mocks.invokeLLM.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const pending = runSidekick(user, { message: "hello" });
    const assertion = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
    await expect(runSidekick(user, { message: "hello" })).rejects.toMatchObject(
      { status: 503, message: expect.stringContaining("busy") }
    );
    finish(ai("Finally finished"));
    await vi.advanceTimersByTimeAsync(1);
  });
  it("enforces a per-member request rate limit at the registered endpoint", async () => {
    mocks.needUser.mockResolvedValue({ ...user, id: 9876 });
    const { post } = await http();
    for (let i = 0; i < 12; i++)
      expect((await post({ message: "find squads" })).status).toBe(200);
    expect((await post({ message: "find squads" })).status).toBe(429);
  });
});
