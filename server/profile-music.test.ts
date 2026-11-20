import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import {
  defaultProfileWorld,
  WORLD_MODULES,
} from "../shared/profile-world-types";
import { defaultProfile } from "../shared/profile-types";
import {
  musicTime,
  musicSessionKey,
  playlistIndex,
  worldMediaUrl,
  playableWorldAudio,
} from "../client/src/components/lounge/profile-music-utils";
import { ProfileMusicPlayer } from "../client/src/components/lounge/ProfileMusicPlayer";
vi.mock("@/lib/app-api", () => ({
  api: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
describe("profile soundtrack and personal mini-site contracts", () => {
  it("preserves old appearance fields while defaulting music art and custom modules to empty", () => {
    const profile = defaultProfile(1);
    expect(profile.theme.moduleOrder).toHaveLength(5);
    expect(profile.world.moduleOrder).toEqual([...WORLD_MODULES]);
    expect(profile.world.music).toEqual([]);
    expect(profile.world.art).toEqual([]);
    expect(profile.world.topPeople).toEqual([]);
    expect(profile.worldMedia).toEqual({});
    const a = defaultProfileWorld(),
      b = defaultProfileWorld();
    a.moduleOrder.reverse();
    expect(b.moduleOrder).toEqual([...WORLD_MODULES]);
  });
  it("accepts only exact same-origin world media and opaque single tickets", () => {
    const origin = "https://respawn.example",
      id = "safe-id",
      path = "/api/media/profile-world/safe-id";
    expect(worldMediaUrl(id, path, origin)).toBe(path);
    expect(worldMediaUrl(id, path + "?ticket=opaque", origin)).toBe(
      path + "?ticket=opaque"
    );
    for (const value of [
      "https://evil.example" + path,
      "javascript:alert(1)",
      "data:audio/mpeg;base64,abc",
      path + "#foo",
      path + "/other",
      path + "?ticket=a&ticket=b",
      path + "?redirect=x",
      path.replace("safe-id", "other"),
    ])
      expect(worldMediaUrl(id, value, origin)).toBeNull();
    expect(worldMediaUrl("../unsafe", path, origin)).toBeNull();
  });
  it("rejects image or mismatched/oversized audio assets as music sources", () => {
    const origin = "https://respawn.example";
    const asset = {
      id: "one",
      kind: "audio" as const,
      url: "/api/media/profile-world/one",
      duration: 60,
    };
    expect(playableWorldAudio(asset, "one", origin)).toBe(asset.url);
    expect(
      playableWorldAudio({ ...asset, kind: "image" }, "one", origin)
    ).toBeNull();
    expect(playableWorldAudio(asset, "two", origin)).toBeNull();
    expect(
      playableWorldAudio({ ...asset, duration: 601 }, "one", origin)
    ).toBeNull();
    expect(
      playableWorldAudio({ ...asset, duration: NaN }, "one", origin)
    ).toBeNull();
  });
  it("wraps playlists and displays truthful bounded timecodes", () => {
    expect(playlistIndex(0, -1, 3)).toBe(2);
    expect(playlistIndex(2, 1, 3)).toBe(0);
    expect(playlistIndex(1, 1, 0)).toBe(0);
    expect(musicTime(65.9)).toBe("1:05");
    expect(musicTime(NaN)).toBe("0:00");
  });
  it("remounts cleanup scope when the first track is added, but keeps ordinary playlist changes stable", () => {
    const empty = createElement(ProfileMusicPlayer, {
      ownerId: 1,
      tracks: [],
      media: {},
    });
    expect(musicSessionKey(1, 0)).not.toBe(musicSessionKey(1, 1));
    expect(musicSessionKey(1, 1)).toBe(musicSessionKey(1, 3));
    expect(musicSessionKey(1, 1)).not.toBe(musicSessionKey(2, 1));
    expect(ProfileMusicPlayer(empty.props).key).toBe(musicSessionKey(1, 0));
    expect(
      ProfileMusicPlayer({
        ...empty.props,
        tracks: [{ title: "First song", artist: "Me", mediaId: "one" }],
      }).key
    ).toBe(musicSessionKey(1, 1));
  });
  it("renders real audio controls without any source loading or autoplay until interaction", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileMusicPlayer, {
        ownerId: 1,
        tracks: [
          { title: "My original song", artist: "My band", mediaId: "one" },
          { title: "Second song", artist: "My band", mediaId: "two" },
        ],
        media: {
          one: {
            id: "one",
            kind: "audio",
            url: "/api/media/profile-world/one",
            duration: 65,
          },
          two: {
            id: "two",
            kind: "audio",
            url: "/api/media/profile-world/two",
            duration: 60,
          },
        },
      })
    );
    expect(html).toContain("<audio");
    expect(html).toContain('preload="none"');
    expect(html).not.toMatch(/auto[Pp]lay/);
    expect(html).not.toContain('src="/api/media');
    expect(html).toContain("Play music");
    expect(html).toContain("Previous track");
    expect(html).toContain("Next track");
    expect(html).toContain("Seek within track");
    expect(html).toContain("Music volume");
    expect(html).toContain("1:05");
    expect(html).toContain("My original song");
  });
  it("shows empty music honestly rather than inventing tracks", () => {
    const html = renderToStaticMarkup(
      createElement(ProfileMusicPlayer, { ownerId: 1, tracks: [], media: {} })
    );
    expect(html).toContain("No tracks selected");
    expect(html).not.toContain("<audio");
  });
});
