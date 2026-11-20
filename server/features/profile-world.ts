import type { Express } from "express";
import { z } from "zod";
import { canViewProfile, type Profile } from "../../shared/profile-types";
import {
  defaultProfileWorld,
  WORLD_MODULES,
  WORLD_LIMITS,
  type ProfileWorld,
  type WorldMedia,
} from "../../shared/profile-world-types";
import { fail, optionalUser, route } from "./access";
import { validAssetId, type ProfileRecord } from "./profile-media";
import {
  worldAsset,
  worldMediaMatches,
  worldReferenced,
  type WorldMediaRecord,
} from "./profile-world-media";
import * as store from "./store";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
      "Control characters are not allowed"
    )
    .refine(value => !/[<>]/u.test(value), "Use plain text, not markup")
    .transform(value => value.trim());
const assetId = z
  .string()
  .refine(validAssetId, "Choose an uploaded world asset");
const musicEntry = z.object({
  title: text(100),
  artist: text(100),
  mediaId: assetId,
});
const artEntry = z.object({
  title: text(100),
  caption: text(500),
  mediaId: assetId,
});
const panelEntry = z.object({
  id: text(40).refine(value => !!value, "Panel ID is required"),
  title: text(80),
  text: text(5000),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color"),
});
const modules = z.object({
  quote: z.boolean(),
  music: z.boolean(),
  art: z.boolean(),
  people: z.boolean(),
  panels: z.boolean(),
});
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const worldBase = z.object({
  quote: text(500),
  quoteAuthor: text(80),
  favoriteMusic: z
    .array(
      text(80).refine(value => !!value, "Empty music tags are not allowed")
    )
    .max(20)
    .refine(
      values => unique(values.map(value => value.toLocaleLowerCase())),
      "Remove duplicate music tags"
    ),
  music: z.array(musicEntry.strict()).max(WORLD_LIMITS.tracks),
  art: z.array(artEntry.strict()).max(WORLD_LIMITS.art),
  panels: z
    .array(panelEntry.strict())
    .max(WORLD_LIMITS.panels)
    .refine(
      values => unique(values.map(value => value.id)),
      "Panel IDs must be unique"
    ),
  topPeople: z
    .array(z.number().int().positive().safe())
    .max(WORLD_LIMITS.people)
    .refine(unique, "Featured people must be unique"),
  modules: modules.strict(),
  moduleOrder: z
    .array(z.enum(WORLD_MODULES))
    .length(WORLD_MODULES.length)
    .refine(unique, "Order every world section exactly once"),
  chrome: z.enum(["glass", "chrome", "minimal"]),
  portrait: z.enum(["round", "square"]),
  pageWidth: z.enum(["wide", "cozy"]),
});
/** Only an entirely omitted world receives defaults; malformed new worlds are never silently repaired. */
export const worldSchema = worldBase.strict().default(defaultProfileWorld);
export const worldDTOSchema = worldBase
  .extend({
    music: z.array(musicEntry.strip()).max(WORLD_LIMITS.tracks),
    art: z.array(artEntry.strip()).max(WORLD_LIMITS.art),
    panels: z
      .array(panelEntry.strip())
      .max(WORLD_LIMITS.panels)
      .refine(
        values => unique(values.map(value => value.id)),
        "Panel IDs must be unique"
      ),
    modules: modules.strip(),
  })
  .strip()
  .default(defaultProfileWorld);

export async function validateWorldAssets(
  world: ProfileWorld,
  ownerId: number
) {
  for (const [kind, entries] of [
    ["audio", world.music],
    ["image", world.art],
  ] as const) {
    for (const entry of entries) {
      const asset = await store.get<WorldMediaRecord>(
        "profile-world-media",
        entry.mediaId
      );
      if (
        !worldMediaMatches(asset, ownerId, kind) ||
        asset.id !== entry.mediaId
      )
        fail(400, "Choose your own uploaded world media of the matching kind");
    }
  }
}
export async function validateWorldPeople(
  world: ProfileWorld,
  viewerId: number,
  parse: (value: ProfileRecord | undefined) => ProfileRecord | undefined
) {
  for (const id of world.topPeople) {
    const profile = parse(
      await store.get<ProfileRecord>("profile", `profile:${id}`)
    );
    if (
      !profile ||
      profile.ownerId !== id ||
      !canViewProfile(profile, viewerId)
    )
      fail(400, "Choose an actual currently visible saved profile");
  }
}
/** Whitelist only selected, owner-owned assets; never trust a stored worldMedia DTO or an old ACL. */
export async function serializeWorldMedia(
  profile: ProfileRecord,
  viewerId?: number
): Promise<WorldMedia> {
  const world = worldDTOSchema.parse(profile.world);
  const result: WorldMedia = {};
  for (const [kind, entries] of [
    ["audio", world.music],
    ["image", world.art],
  ] as const) {
    for (const entry of entries) {
      const asset = await store.get<WorldMediaRecord>(
        "profile-world-media",
        entry.mediaId
      );
      if (
        worldMediaMatches(asset, profile.ownerId, kind) &&
        asset.id === entry.mediaId
      )
        result[asset.id] = worldAsset(
          asset,
          viewerId,
          profile.saved && profile.settings.visibility === "public"
        );
    }
  }
  if (!profile.saved) return result;
  const current = await store.get<ProfileRecord>(
    "profile",
    `profile:${profile.ownerId}`
  );
  if (
    !current ||
    current.id !== profile.id ||
    current.ownerId !== profile.ownerId ||
    current.saved !== true ||
    (current as ProfileRecord & { deletedAt?: string }).deletedAt ||
    !current.settings ||
    !canViewProfile(current, viewerId)
  )
    fail(404, "Profile not found");
  for (const id of Object.keys(result)) {
    const asset = await store.get<WorldMediaRecord>("profile-world-media", id);
    if (
      !asset ||
      !worldMediaMatches(asset, current.ownerId, result[id].kind) ||
      !worldReferenced(current, asset)
    )
      delete result[id];
  }
  // Asset lookups can yield: privacy must still hold immediately before returning the DTO.
  const latest = await store.get<ProfileRecord>("profile", current.id);
  if (
    !latest ||
    latest.saved !== true ||
    latest.ownerId !== profile.ownerId ||
    latest.id !== profile.id ||
    (latest as ProfileRecord & { deletedAt?: string }).deletedAt ||
    !latest.settings ||
    !canViewProfile(latest, viewerId)
  )
    fail(404, "Profile not found");
  for (const id of Object.keys(result)) {
    if (
      !worldReferenced(latest, {
        id,
        kind: result[id].kind,
        ownerId: latest.ownerId,
      } as WorldMediaRecord)
    )
      delete result[id];
  }
  return result;
}

export function registerWorldFeaturedRoute(
  app: Express,
  helpers: {
    parse: (value: ProfileRecord | undefined) => ProfileRecord | undefined;
    serialize: (profile: ProfileRecord, viewerId?: number) => Promise<Profile>;
  }
) {
  app.get(
    "/api/app/profiles/:id/featured",
    route(async (req, res) => {
      const user = await optionalUser(req);
      if (
        !/^[1-9]\d*$/.test(req.params.id) ||
        !Number.isSafeInteger(Number(req.params.id))
      )
        fail(404, "Profile not found");
      const id = Number(req.params.id);
      const readOwner = async () => {
        const owner = helpers.parse(
          await store.get<ProfileRecord>("profile", `profile:${id}`)
        );
        if (!owner || owner.ownerId !== id || !canViewProfile(owner, user?.id))
          fail(404, "Profile not found");
        return owner;
      };
      const owner = await readOwner();
      const people: Profile[] = [];
      for (const personId of owner.world.topPeople) {
        const person = helpers.parse(
          await store.get<ProfileRecord>("profile", `profile:${personId}`)
        );
        if (
          !person ||
          person.ownerId !== personId ||
          !canViewProfile(person, user?.id)
        )
          continue;
        try {
          people.push(await helpers.serialize(person, user?.id));
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "status" in error &&
              error.status === 404
            )
          )
            throw error;
        }
      }
      // Final owner/target reads form one gate; no later asynchronous work can stale these ACL checks.
      const [ownerRecord, ...targetRecords] = await Promise.all([
        store.get<ProfileRecord>("profile", `profile:${id}`),
        ...people.map(person =>
          store.get<ProfileRecord>("profile", `profile:${person.ownerId}`)
        ),
      ]);
      const current = helpers.parse(ownerRecord);
      if (
        !current ||
        current.ownerId !== id ||
        !canViewProfile(current, user?.id)
      )
        fail(404, "Profile not found");
      const visible = new Set<number>();
      for (let index = 0; index < targetRecords.length; index++) {
        const target = helpers.parse(targetRecords[index]);
        if (
          target &&
          target.ownerId === people[index].ownerId &&
          canViewProfile(target, user?.id)
        )
          visible.add(target.ownerId);
      }
      const output: Profile[] = [];
      for (const personId of current.world.topPeople) {
        const person = people.find(value => value.ownerId === personId);
        if (person && visible.has(personId)) output.push(person);
      }
      res.json(output);
    })
  );
}
