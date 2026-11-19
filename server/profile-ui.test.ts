import { describe, expect, it } from "vitest";
import {
  AVATAR_EMOJIS,
  PROFILE_MODULES,
  defaultProfile,
} from "../shared/profile-types";
import {
  colorWithOpacity,
  moveProfileModule,
  profileInput,
  profileMediaForm,
  profileMediaUrl,
  profileUploadError,
  safeSocialUrl,
  validateProfileDraft,
  PROFILE_TEXT_LIMITS,
  THEME_COLORS,
  THEME_SHAPE,
  THEME_BACKGROUND,
  THEME_GHOST,
  SOCIAL_SETTINGS,
  MOTION_SETTINGS,
} from "../client/src/components/lounge/profile-utils";

const origin = "https://respawn.example";
const asset = "d2dac23a-8517-4aa1-b927-c5db9963503a";
describe("profile UI media boundary", () => {
  it("allows only exact same-origin application-owned resources and opaque tickets", () => {
    const path = `/api/media/profile/${asset}`;
    expect(profileMediaUrl(asset, path, origin)).toBe(path);
    expect(
      profileMediaUrl(asset, `${origin}${path}?ticket=opaque%2Bvalue`, origin)
    ).toBe(`${path}?ticket=opaque%2Bvalue`);
    expect(
      profileMediaUrl(asset, `${path}/poster?ticket=poster`, origin, true)
    ).toBe(`${path}/poster?ticket=poster`);
    for (const url of [
      `https://evil.example${path}`,
      `//evil.example${path}`,
      `data:image/png;base64,anything`,
      `javascript:alert(1)`,
      `blob:${origin}/file`,
      `${path}/poster`,
      `${path}/other`,
      `${path}?redirect=https://evil.example`,
      `${path}?ticket=a&ticket=b`,
      `${path}#anything`,
      `${origin.replace("https:", "http:")}${path}`,
      `${path}/../other`,
      `${path}%2Fposter`,
      `https://person:password@respawn.example${path}`,
    ]) {
      expect(profileMediaUrl(asset, url, origin), url).toBeNull();
    }
    expect(
      profileMediaUrl("../escape", `/api/media/profile/../escape`, origin)
    ).toBeNull();
    expect(profileMediaUrl(asset, undefined, origin)).toBeNull();
  });
  it("rejects video in static slots, empty files and byte-limit violations", () => {
    const file = { type: "image/png", name: "art.png", size: 8 * 1024 * 1024 };
    expect(profileUploadError(file, "avatar")).toBeNull();
    expect(
      profileUploadError({ ...file, size: file.size + 1 }, "ghost")
    ).toMatch(/8 MiB/);
    expect(profileUploadError({ ...file, size: 0 }, "banner")).toMatch(/empty/);
    expect(
      profileUploadError({ ...file, type: "image/svg+xml" }, "avatar")
    ).toMatch(/JPEG/);
    expect(
      profileUploadError({ ...file, type: "video/mp4" }, "avatar")
    ).toMatch(/Only the background/);
    expect(
      profileUploadError(
        { ...file, type: "video/webm", size: 20 * 1024 * 1024 },
        "background"
      )
    ).toBeNull();
    expect(
      profileUploadError(
        { ...file, type: "video/mp4", size: 20 * 1024 * 1024 + 1 },
        "background"
      )
    ).toMatch(/20 MiB/);
  });
  it("sends authorization metadata before file bytes", () => {
    const form = profileMediaForm(
      new File(["example"], "art.png", { type: "image/png" }),
      "ghost"
    );
    expect([...form.keys()]).toEqual(["slot", "confirmed", "file"]);
    expect(form.get("slot")).toBe("ghost");
    expect(form.get("confirmed")).toBe("true");
    expect((form.get("file") as File).name).toBe("art.png");
  });
});
describe("complete profile drafts", () => {
  it("serializes all writable fields without DTO metadata or storage/media URLs", () => {
    const profile = defaultProfile(42, "Player");
    profile.media.avatar = {
      id: asset,
      kind: "image",
      url: `/api/media/profile/${asset}?ticket=private`,
      width: 100,
      height: 100,
    };
    profile.avatarMediaId = asset;
    profile.saved = true;
    profile.createdAt = "2026-01-01";
    profile.updatedAt = "2026-02-01";
    const input = profileInput(profile);
    const {
      ownerId: _owner,
      media: _media,
      saved: _saved,
      createdAt: _created,
      updatedAt: _updated,
      ...writable
    } = profile;
    expect(input).toEqual(writable);
    expect(JSON.stringify(input)).not.toContain("ticket");
    expect(input.avatarMediaId).toBe(asset);
    expect(input.theme.moduleOrder).toEqual(PROFILE_MODULES);
    expect(input.settings).toEqual(profile.settings);
    input.theme.moduleOrder.reverse();
    input.settings.visibility = "private";
    expect(profile.settings.visibility).toBe("public");
    expect(profile.theme.moduleOrder).toEqual(PROFILE_MODULES);
  });
  it("retains every required default field and all thirty avatars", () => {
    expect(AVATAR_EMOJIS).toHaveLength(30);
    const profile = defaultProfile(42);
    expect(validateProfileDraft(profile)).toBeNull();
    expect(profile.saved).toBe(false);
    expect(profile.settings.autoplayBackground).toBe(false);
    expect(Object.keys(profile.settings)).toHaveLength(8);
    expect(Object.keys(profile.theme)).toHaveLength(22);
  });
  it("provides structured controls for the entire appearance and privacy model", () => {
    const profile = defaultProfile(42);
    const appearance = new Set(
      [
        ...THEME_COLORS,
        ...THEME_SHAPE,
        ...THEME_BACKGROUND,
        ...THEME_GHOST,
      ].map(field => field.key)
    );
    expect([...appearance, "modules", "moduleOrder"].sort()).toEqual(
      Object.keys(profile.theme).sort()
    );
    expect(
      [
        "visibility",
        "discoverable",
        ...SOCIAL_SETTINGS.map(field => field.key),
        ...MOTION_SETTINGS.map(field => field.key),
      ].sort()
    ).toEqual(Object.keys(profile.settings).sort());
  });
  it("validates full-payload limits even when an editor tab is not active", () => {
    const profile = defaultProfile(42);
    profile.bio = "a".repeat(PROFILE_TEXT_LIMITS.bio);
    expect(validateProfileDraft(profile)).toBeNull();
    profile.bio += "a";
    expect(validateProfileDraft(profile)).toMatch(/too long/);
    profile.bio = "plain";
    profile.theme.accentColor = "red;background:url(evil)";
    expect(validateProfileDraft(profile)).toMatch(/six-digit/);
    profile.theme.accentColor = "#00e5ff";
    profile.displayName = "<script>";
    expect(validateProfileDraft(profile)).toMatch(/plain text/);
    profile.displayName = "Player";
    profile.roles = [];
    expect(validateProfileDraft(profile)).toMatch(/role/);
  });
  it("requires actual matching uploaded media for image/video modes", () => {
    const profile = defaultProfile(42);
    profile.theme.backgroundMode = "image";
    expect(validateProfileDraft(profile)).toMatch(/background image/);
    profile.theme.backgroundMode = "video";
    expect(validateProfileDraft(profile)).toMatch(/background video/);
  });
  it("moves all five sections without deletion, duplicates or mutation", () => {
    const order = [...PROFILE_MODULES];
    expect(moveProfileModule(order, "about", -1)).toEqual(order);
    expect(moveProfileModule(order, "clips", 1)).toEqual(order);
    const next = moveProfileModule(order, "about", 1);
    expect(next).toEqual(["links", "about", "games", "posts", "clips"]);
    expect(new Set(next).size).toBe(5);
    expect(order).toEqual(PROFILE_MODULES);
  });
});
describe("structured colors and social URLs", () => {
  it("restricts links to safe credential-free HTTPS destinations", () => {
    expect(safeSocialUrl("https://example.com/channel?tab=videos")).toBe(
      "https://example.com/channel?tab=videos"
    );
    for (const value of [
      "http://example.com",
      "javascript:alert(1)",
      "//example.com",
      "https://person:secret@example.com",
      "https://example.com/has space",
      " https://example.com",
      "https://localhost",
      "data:text/html,hello",
    ])
      expect(safeSocialUrl(value), value).toBeNull();
    const profile = defaultProfile(42);
    profile.links = [{ label: "Channel", url: "javascript:alert(1)" }];
    expect(validateProfileDraft(profile)).toMatch(/https/);
  });
  it("bounds opacity and never emits arbitrary CSS", () => {
    expect(colorWithOpacity("#123456", 1)).toBe("#123456ff");
    expect(colorWithOpacity("#ffffff", 0)).toBe("#ffffff00");
    expect(colorWithOpacity("#ffffff", 5)).toBe("#ffffffff");
    expect(colorWithOpacity("#ffffff", -5)).toBe("#ffffff00");
    expect(colorWithOpacity("url(evil)", NaN)).toBe("#121625ff");
  });
});
