import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defaultProfile } from "../shared/profile-types";
import { WORLD_MODULES } from "../shared/profile-world-types";
import { profileInput } from "../client/src/components/lounge/profile-utils";
import {
  chromeProfilePreset,
  profileWorld,
  validateWorldDraft,
  worldMediaForm,
  worldUploadError,
  moveWorldItem,
  selectedWorldMedia,
  validWorldAsset,
} from "../client/src/components/lounge/world-utils";
const read = (path: string) => readFileSync(path, "utf8");
const uuid = "d2dac23a-8517-4aa1-b927-c5db9963503a";
describe("personal mini-site editor integration", () => {
  it("keeps Chrome optional and preserves previous uploaded backgrounds and privacy", () => {
    const base = defaultProfile(1);
    base.settings.visibility = "private";
    base.backgroundMediaId = uuid;
    base.theme.backgroundMode = "video";
    const next = chromeProfilePreset(base);
    expect(next.world.chrome).toBe("chrome");
    expect(next.world.portrait).toBe("square");
    expect(next.world.pageWidth).toBe("cozy");
    expect(next.theme.layout).toBe("classic");
    expect(next.backgroundMediaId).toBe(uuid);
    expect(next.theme.backgroundMode).toBe("video");
    expect(next.settings.visibility).toBe("private");
    expect(base.world.chrome).toBe("glass");
  });
  it("serializes full personal settings but never world-media URLs or DTO metadata", () => {
    const profile = defaultProfile(1);
    profile.world.quote = "Make it yours";
    profile.world.art = [{ title: "My art", caption: "", mediaId: uuid }];
    profile.worldMedia[uuid] = {
      id: uuid,
      kind: "image",
      url: `/api/media/profile-world/${uuid}?ticket=secret`,
      width: 100,
      height: 100,
    };
    const value = profileInput(profile);
    expect(value.world).toEqual(profile.world);
    expect(value).not.toHaveProperty("worldMedia");
    expect(JSON.stringify(value)).not.toContain("ticket");
    expect(value).not.toHaveProperty("ownerId");
  });
  it("supplies safe empty defaults to legacy profiles and rejects invalid custom worlds", () => {
    const value = profileWorld();
    expect(value.moduleOrder).toEqual([...WORLD_MODULES]);
    expect(validateWorldDraft(value)).toBeNull();
    value.quote = "x".repeat(501);
    expect(validateWorldDraft(value)).toMatch(/500/);
    value.quote = "";
    value.panels = [
      { id: "one", title: "Setup", text: "<script>", accentColor: "#00e5ff" },
    ];
    expect(validateWorldDraft(value)).not.toBeNull();
    value.panels = [];
    value.moduleOrder = ["quote", "quote", "art", "people", "panels"];
    expect(validateWorldDraft(value)).not.toBeNull();
  });
  it("requires music rights confirmation before uploading and sends metadata before file bytes", () => {
    const file = new File(["fakebytes"], "my-song.mp3", { type: "audio/mp3" });
    expect(worldUploadError(file, "music", false)).toMatch(/permission/);
    expect(worldUploadError(file, "music", true)).toBeNull();
    const form = worldMediaForm(file, "music", true);
    expect([...form.keys()]).toEqual([
      "slot",
      "confirmed",
      "rightsConfirmed",
      "file",
    ]);
    expect(form.get("rightsConfirmed")).toBe("true");
    expect((form.get("file") as File).type).toBe("audio/mpeg");
    expect(
      worldUploadError(
        {
          ...file,
          name: "song.mp3",
          type: "audio/mpeg",
          size: 15 * 1024 * 1024 + 1,
        },
        "music",
        true
      )
    ).toMatch(/15 MiB/);
  });
  it("permits only static gallery images and matching application-owned world resources", () => {
    expect(
      worldUploadError(
        { name: "art.svg", type: "image/svg+xml", size: 100 },
        "art"
      )
    ).toMatch(/JPEG/);
    expect(
      validWorldAsset(
        {
          id: uuid,
          kind: "audio",
          duration: 60,
          url: `/api/media/profile-world/${uuid}`,
        },
        "music",
        "https://respawn.example"
      )
    ).toBe(true);
    expect(
      validWorldAsset(
        {
          id: uuid,
          kind: "image",
          width: 100,
          height: 100,
          url: `https://evil.example/api/media/profile-world/${uuid}`,
        },
        "art",
        "https://respawn.example"
      )
    ).toBe(false);
  });
  it("reorders tracks and art without mutating the original and prunes removed artwork from drafts", () => {
    const original = ["one", "two", "three"];
    expect(moveWorldItem(original, 0, 1)).toEqual(["two", "one", "three"]);
    expect(original).toEqual(["one", "two", "three"]);
    const world = profileWorld();
    world.art = [{ title: "art", caption: "", mediaId: uuid }];
    expect(
      Object.keys(
        selectedWorldMedia(world, {
          [uuid]: { id: uuid, kind: "image", url: "safe" },
          other: { id: "other", kind: "image", url: "unsafe" },
        })
      )
    ).toEqual([uuid]);
  });
  it("connects world display, personal editor, classic composition and permission-scoped route registration", () => {
    const profile = read("client/src/components/lounge/Profile.tsx"),
      editor = read("client/src/components/lounge/ProfileEditor.tsx"),
      backend = read("server/features/profiles.ts");
    expect(profile).toContain("<ProfileWorld");
    expect(profile).toContain("data-chrome");
    expect(profile).toContain("readOnly={preview}");
    expect(editor).toContain("<WorldEditor");
    expect(backend).toContain("registerWorld");
    const css = read("client/src/components/lounge/profile-world.css");
    expect(css).toContain("member-portrait-square");
    expect(css).toContain("member-width-cozy");
    expect(css).toContain("@media");
  });
});
