import type { Express } from "express";
import { z } from "zod";
import {
  AVATAR_EMOJIS,
  PROFILE_LIMITS,
  PROFILE_MODULES,
  PROFILE_ROLES,
  canViewProfile,
  defaultProfile,
  type Profile,
  type ProfileInput,
} from "../../shared/profile-types";
import { fail, needUser, optionalUser, route } from "./access";
import {
  PROFILE_SLOTS,
  mediaMatches,
  profileAsset,
  registerProfileMediaRoutes,
  validAssetId,
  type ProfileMediaRecord,
  type ProfileRecord,
} from "./profile-media";
import * as store from "./store";
import {
  worldSchema,
  worldDTOSchema,
  validateWorldAssets,
  validateWorldPeople,
  serializeWorldMedia,
  registerWorldFeaturedRoute,
} from "./profile-world";
import { registerWorldMediaRoutes } from "./profile-world-media";

// Profile appearance is structured data, never HTML, CSS, scripts or external artwork URLs.
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
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color");
const opacity = z.number().finite().min(0).max(1);
const emoji = z
  .string()
  .max(32)
  .refine(
    value =>
      value === "" ||
      (/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3/u.test(
        value
      ) &&
        !/[^\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}0-9#*]/u.test(
          value
        )),
    "Use a short emoji status"
  );
const modulesSchema = z
  .object({
    about: z.boolean(),
    links: z.boolean(),
    games: z.boolean(),
    posts: z.boolean(),
    clips: z.boolean(),
  })
  .strict();
const themeSchema = z
  .object({
    backgroundMode: z.enum(["solid", "gradient", "image", "video"]),
    backgroundColor: hex,
    backgroundColor2: hex,
    accentColor: hex,
    secondaryColor: hex,
    textColor: hex,
    cardColor: hex,
    cardOpacity: opacity,
    backgroundOpacity: opacity,
    overlayOpacity: opacity,
    backgroundBlur: z.number().finite().min(0).max(24),
    backgroundSize: z.enum(["cover", "contain", "tile"]),
    backgroundPosition: z.enum(["center", "top", "bottom"]),
    ghostOpacity: opacity,
    ghostPosition: z.enum([
      "center",
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ]),
    ghostSize: z.enum(["small", "medium", "large"]),
    font: z.enum(["inter", "space", "mono"]),
    layout: z.enum(["classic", "spotlight", "compact"]),
    corners: z.enum(["square", "rounded", "soft"]),
    glow: z.enum(["none", "subtle", "strong"]),
    modules: modulesSchema,
    moduleOrder: z
      .array(z.enum(PROFILE_MODULES))
      .length(PROFILE_MODULES.length)
      .refine(
        value => new Set(value).size === PROFILE_MODULES.length,
        "Order every section exactly once"
      ),
  })
  .strict();
const settingsSchema = z
  .object({
    visibility: z.enum(["public", "members", "private"]),
    discoverable: z.boolean(),
    allowFollow: z.boolean(),
    allowComments: z.boolean(),
    allowReactions: z.boolean(),
    showFollowerCount: z.boolean(),
    reducedMotion: z.boolean(),
    autoplayBackground: z.boolean(),
  })
  .strict();
const uniqueText = (maxItems: number, maxText: number) =>
  z
    .array(
      text(maxText).refine(value => !!value, "Empty entries are not allowed")
    )
    .max(maxItems)
    .refine(
      values =>
        new Set(values.map(value => value.toLocaleLowerCase())).size ===
        values.length,
      "Remove duplicate entries"
    );
const mediaId = z
  .string()
  .refine(validAssetId, "Choose an uploaded profile asset")
  .nullable();
const urlSchema = text(500).refine(value => {
  if (/\s|[\\\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.includes(".") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}, "Use a complete HTTPS link without credentials");
const inputSchema = z
  .object({
    displayName: text(80).refine(value => !!value, "Display name is required"),
    headline: text(160),
    bio: text(5000),
    pronouns: text(40),
    roles: z
      .array(z.enum(PROFILE_ROLES))
      .min(1)
      .max(PROFILE_ROLES.length)
      .refine(
        value => new Set(value).size === value.length,
        "Remove duplicate roles"
      ),
    status: text(120),
    statusEmoji: emoji,
    avatarEmoji: z.enum(AVATAR_EMOJIS),
    games: uniqueText(20, 80),
    platforms: uniqueText(20, 80),
    links: z
      .array(
        z
          .object({
            label: text(60).refine(value => !!value, "Link label is required"),
            url: urlSchema,
          })
          .strict()
      )
      .max(PROFILE_LIMITS.links),
    avatarMediaId: mediaId,
    bannerMediaId: mediaId,
    backgroundMediaId: mediaId,
    ghostMediaId: mediaId,
    world: worldSchema,
    theme: themeSchema,
    settings: settingsSchema,
  })
  .strict();
const patchSchema = inputSchema.extend({
  world: worldSchema.removeDefault().optional(),
  confirmed: z.literal(true),
});
// Nested strip schemas are a defense-in-depth DTO whitelist for legacy/unexpected stored fields.
const dtoInputSchema = inputSchema
  .extend({
    world: worldDTOSchema,
    theme: themeSchema.extend({ modules: modulesSchema.strip() }).strip(),
    settings: settingsSchema.strip(),
    links: z
      .array(z.object({ label: text(60), url: urlSchema }).strip())
      .max(PROFILE_LIMITS.links),
  })
  .strip();
function parseInput(
  value: unknown
): Omit<ProfileInput, "world"> & { world?: ProfileInput["world"] } {
  const result = patchSchema.safeParse(value);
  if (!result.success)
    fail(400, result.error.issues[0]?.message ?? "Invalid profile settings");
  const { confirmed: _confirmed, ...fields } = result.data;
  return fields;
}
function savedProfile(
  value: ProfileRecord | undefined
): ProfileRecord | undefined {
  if (
    !value ||
    value.saved !== true ||
    (value as ProfileRecord & { deletedAt?: string }).deletedAt ||
    !Number.isSafeInteger(value.ownerId) ||
    value.ownerId <= 0 ||
    value.id !== `profile:${value.ownerId}`
  )
    return;
  const result = dtoInputSchema.safeParse(value);
  if (!result.success) return;
  return {
    ...result.data,
    id: value.id,
    ownerId: value.ownerId,
    saved: true,
    ...(typeof value.createdAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.createdAt)
      ? { createdAt: value.createdAt }
      : {}),
    ...(typeof value.updatedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.updatedAt)
      ? { updatedAt: value.updatedAt }
      : {}),
  };
}
async function serialize(
  profile: ProfileRecord,
  viewerId?: number
): Promise<Profile> {
  const fields = dtoInputSchema.parse(profile);
  const media: Profile["media"] = {};
  for (const slot of PROFILE_SLOTS) {
    const id = fields[`${slot}MediaId`];
    if (!id) continue;
    const asset = await store.get<ProfileMediaRecord>("profile-media", id);
    if (mediaMatches(asset, profile.ownerId, slot) && asset.id === id)
      media[slot] = profileAsset(
        asset,
        viewerId,
        profile.saved && profile.settings.visibility === "public"
      );
  }
  return {
    ...fields,
    ownerId: profile.ownerId,
    media,
    worldMedia: await serializeWorldMedia(profile, viewerId),
    saved: profile.saved,
    ...(profile.createdAt ? { createdAt: profile.createdAt } : {}),
    ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  };
}
async function validateMedia(
  fields: Omit<ProfileInput, "world">,
  ownerId: number
) {
  for (const slot of PROFILE_SLOTS) {
    const id = fields[`${slot}MediaId`];
    if (id === null) continue;
    const asset = await store.get<ProfileMediaRecord>("profile-media", id);
    if (!mediaMatches(asset, ownerId, slot) || asset.id !== id)
      fail(400, "Choose your own uploaded media for its original profile slot");
    if (
      slot === "background" &&
      ((fields.theme.backgroundMode === "image" && asset.kind !== "image") ||
        (fields.theme.backgroundMode === "video" && asset.kind !== "video"))
    )
      fail(400, "Background mode must match the selected media kind");
  }
}
function ownerId(value: string) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail(404, "Profile not found");
  return Number(value);
}
export function registerProfileRoutes(app: Express) {
  app.get(
    "/api/app/profile/me",
    route(async (req, res) => {
      const user = await needUser(req);
      const profile = savedProfile(
        await store.get<ProfileRecord>("profile", `profile:${user.id}`)
      );
      // This is a local default, not a saved member or a directory entry. GET never writes.
      res.json(
        profile
          ? await serialize(profile, user.id)
          : defaultProfile(user.id, user.name?.trim().slice(0, 80) || "Gamer")
      );
    })
  );
  app.patch(
    "/api/app/profile/me",
    route(async (req, res) => {
      const user = await needUser(req),
        fields = parseInput(req.body);
      await validateMedia(fields, user.id);
      if (fields.world) {
        await validateWorldAssets(fields.world, user.id);
        await validateWorldPeople(fields.world, user.id, savedProfile);
      }
      const id = `profile:${user.id}`,
        now = new Date().toISOString();
      const write = (current?: ProfileRecord): ProfileRecord => {
        if (current && (current.ownerId !== user.id || current.id !== id))
          fail(403, "Profile ownership does not match");
        return {
          ...fields,
          // Older clients omit world. Preserve the row-locked current value rather than an earlier snapshot.
          world: fields.world ?? worldDTOSchema.parse(current?.world),
          id,
          ownerId: user.id,
          saved: true,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
      };
      let profile: ProfileRecord;
      const existing = await store.get<ProfileRecord>("profile", id);
      if (existing)
        profile = await store.mutate<ProfileRecord>("profile", id, write);
      else {
        try {
          profile = await store.create("profile", user.id, write());
        } catch (error) {
          // The unique deterministic id makes concurrent first saves converge without phantom members.
          if (!(await store.get("profile", id))) throw error;
          profile = await store.mutate<ProfileRecord>("profile", id, write);
        }
      }
      res.json(await serialize(profile, user.id));
    })
  );
  app.get(
    "/api/app/profiles",
    route(async (req, res) => {
      const user = await optionalUser(req);
      const search = req.query.search ?? "",
        role = req.query.role ?? "";
      if (
        typeof search !== "string" ||
        search.length > 100 ||
        /[\u0000-\u001f]/.test(search)
      )
        fail(400, "Invalid member search");
      if (
        typeof role !== "string" ||
        (role !== "" && !(PROFILE_ROLES as readonly string[]).includes(role))
      )
        fail(400, "Invalid member role");
      const query = search.trim().toLocaleLowerCase();
      const profiles = (await store.list<ProfileRecord>("profile"))
        .map(savedProfile)
        .filter(
          (profile): profile is ProfileRecord =>
            !!profile &&
            profile.settings.discoverable &&
            profile.settings.visibility !== "private" &&
            canViewProfile(profile, user?.id) &&
            (!role ||
              profile.roles.includes(role as Profile["roles"][number])) &&
            (!query ||
              [
                profile.displayName,
                profile.headline,
                profile.bio,
                ...profile.games,
                ...profile.platforms,
              ]
                .join(" ")
                .toLocaleLowerCase()
                .includes(query))
        )
        .sort(
          (a, b) =>
            a.displayName.localeCompare(b.displayName) || a.ownerId - b.ownerId
        )
        .slice(0, 60);
      res.json(
        await Promise.all(profiles.map(profile => serialize(profile, user?.id)))
      );
    })
  );
  app.get(
    "/api/app/profiles/:id",
    route(async (req, res) => {
      const user = await optionalUser(req),
        id = ownerId(req.params.id);
      const profile = savedProfile(
        await store.get<ProfileRecord>("profile", `profile:${id}`)
      );
      if (
        !profile ||
        profile.ownerId !== id ||
        !canViewProfile(profile, user?.id)
      )
        fail(404, "Profile not found");
      res.json(await serialize(profile, user?.id));
    })
  );
  registerProfileMediaRoutes(app);
  registerWorldFeaturedRoute(app, { parse: savedProfile, serialize });
  registerWorldMediaRoutes(app);
}
