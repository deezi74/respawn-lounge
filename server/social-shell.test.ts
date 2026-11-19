import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { insertEmoji } from "../client/src/components/lounge/emoji-utils";
import {
  defaultProfile,
  canViewProfile,
  PROFILE_MODULES,
  AVATAR_EMOJIS,
} from "../shared/profile-types";
const read = (path: string) => readFileSync(path, "utf8");
describe("social shell and personal worlds", () => {
  it("inserts complete emoji at a caret or selection without truncation", () => {
    expect(insertEmoji("Good game", "🔥", 4, 4)).toEqual({
      value: "Good🔥 game",
      caret: 6,
    });
    expect(insertEmoji("Good game", "🎮", 5, 9).value).toBe("Good 🎮");
    expect(insertEmoji("abc", "🔥", 3, 3, 4).value).toBe("abc");
    expect(insertEmoji("abc", "🔥", 1, 2, 4).value).toBe("a🔥c");
  });
  it("defaults to real gamer options with motion opt-in and complete reorderable modules", () => {
    const value = defaultProfile(1, "One");
    expect(value.saved).toBe(false);
    expect(value.ownerId).toBe(1);
    expect(value.displayName).toBe("One");
    expect(value.settings.autoplayBackground).toBe(false);
    expect(value.theme.moduleOrder).toEqual([...PROFILE_MODULES]);
    expect(AVATAR_EMOJIS.length).toBeGreaterThanOrEqual(30);
    expect(value.media).toEqual({});
  });
  it("distinguishes public, members-only and private profile access", () => {
    const value = defaultProfile(1);
    expect(canViewProfile(value)).toBe(true);
    value.settings.visibility = "members";
    expect(canViewProfile(value)).toBe(false);
    expect(canViewProfile(value, 2)).toBe(true);
    value.settings.visibility = "private";
    expect(canViewProfile(value, 2)).toBe(false);
    expect(canViewProfile(value, 1)).toBe(true);
  });
  it("provides discoverable social profiles and keeps private clips separate", () => {
    const home = read("client/src/pages/Home.tsx"),
      app = read("client/src/App.tsx");
    for (const path of ["/people", "/profile/edit", "/u/:id"])
      expect(app).toContain(JSON.stringify(path));
    expect(home).toContain("<PeoplePage");
    expect(home).toContain("<ProfileEditor");
    expect(home).toContain("<ProfilePage");
    expect(home).toContain("My Profile");
    expect(home).toContain('path === "/tray"');
    const routes = JSON.parse(read("client/public/manus-routes.json")).routes;
    for (const path of ["/people", "/profile/edit", "/u/:id", "/tray"])
      expect(routes.some((r: { path: string }) => r.path === path)).toBe(true);
  });
  it("gives posts a real emoji picker, social controls and author profile links", () => {
    const source = read("client/src/components/lounge/Posts.tsx");
    expect(source).toContain("<EmojiPicker");
    expect(source).toContain("<PostSocialControls postId={post.id}");
    expect(source).toContain("`/u/${post.ownerId}`");
    expect(read("server/features/posts.ts")).toContain(
      "export async function assertPostReadable"
    );
  });
  it("keeps account chrome distinct from member-specific appearance", () => {
    const global = read("client/src/index.css");
    expect(global).not.toContain("--profile-bg:");
    expect(read("client/src/components/lounge/SettingsStudio.tsx")).toContain(
      'href="/profile/edit"'
    );
  });
  it("connects profile and social routes before static serving", () => {
    const source = read("server/_core/index.ts");
    expect(source).toContain("registerProfileRoutes(app)");
    expect(source).toContain("registerSocialRoutes(app)");
    expect(source.indexOf("registerSocialRoutes(app)")).toBeLessThan(
      source.indexOf("serveStatic(app)")
    );
  });
});
