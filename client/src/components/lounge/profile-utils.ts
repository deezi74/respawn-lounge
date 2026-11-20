import {
  createElement as h,
  Fragment,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Plus, X } from "lucide-react";
import type { ProfileTheme } from "@shared/profile-types";
import { profileWorld, validateWorldDraft } from "./world-utils";
import {
  PROFILE_LIMITS,
  type Profile,
  type ProfileInput,
  type ProfileModule,
} from "@shared/profile-types";

export type ProfileSlot = "avatar" | "banner" | "background" | "ghost";
export const PROFILE_TEXT_LIMITS = {
  displayName: 80,
  headline: 160,
  bio: 5000,
  pronouns: 40,
  status: 120,
  statusEmoji: 32,
  game: 80,
  platform: 80,
  tags: 20,
  linkLabel: 60,
  linkUrl: 500,
} as const;
export const PROFILE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const PROFILE_VIDEO_TYPES = ["video/mp4", "video/webm"];

/** Only exact application-owned profile resources may enter an image, video, or CSS URL. */
export function profileMediaUrl(
  assetId: string,
  value: string | undefined,
  origin: string,
  poster = false
): string | null {
  try {
    if (!value || !assetId || !/^[a-zA-Z0-9_-]+$/.test(assetId)) return null;
    const url = new URL(value, origin);
    if (
      url.origin !== new URL(origin).origin ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !==
        `/api/media/profile/${encodeURIComponent(assetId)}${poster ? "/poster" : ""}`
    )
      return null;
    // The server owns opaque exact-resource tickets; never accept arbitrary query parameters.
    if (
      [...url.searchParams.keys()].some(key => key !== "ticket") ||
      url.searchParams.getAll("ticket").length > 1
    )
      return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
export function safeSocialUrl(value: string): string | null {
  try {
    if (
      !value ||
      value !== value.trim() ||
      /[\\\u0000-\u0020\u007f]/.test(value)
    )
      return null;
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname.includes(".")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function profileInput(profile: Profile): ProfileInput {
  return structuredClone({
    displayName: profile.displayName,
    headline: profile.headline,
    bio: profile.bio,
    pronouns: profile.pronouns,
    roles: profile.roles,
    status: profile.status,
    statusEmoji: profile.statusEmoji,
    avatarEmoji: profile.avatarEmoji,
    games: profile.games,
    platforms: profile.platforms,
    links: profile.links,
    avatarMediaId: profile.avatarMediaId,
    bannerMediaId: profile.bannerMediaId,
    backgroundMediaId: profile.backgroundMediaId,
    ghostMediaId: profile.ghostMediaId,
    world: profileWorld(profile.world),
    theme: profile.theme,
    settings: profile.settings,
  });
}
export function profileUploadError(
  file: Pick<File, "size" | "type" | "name">,
  slot: ProfileSlot
): string | null {
  const video = PROFILE_VIDEO_TYPES.includes(file.type);
  if (
    !PROFILE_IMAGE_TYPES.includes(file.type) &&
    !(slot === "background" && video)
  )
    return "Choose JPEG, PNG or WebP artwork. Only the background also accepts MP4 or WebM.";
  if (file.size === 0) return "This file is empty. Choose another file.";
  if (
    file.size > (video ? PROFILE_LIMITS.videoBytes : PROFILE_LIMITS.imageBytes)
  )
    return video
      ? "Background video must be 20 MiB or smaller and no longer than 30 seconds."
      : "Artwork must be 8 MiB or smaller.";
  return null;
}
export function profileMediaForm(file: File, slot: ProfileSlot): FormData {
  const form = new FormData();
  form.append("slot", slot);
  form.append("confirmed", "true");
  form.append("file", file);
  return form;
}
export function moveProfileModule(
  order: ProfileModule[],
  module: ProfileModule,
  direction: -1 | 1
): ProfileModule[] {
  const index = order.indexOf(module),
    next = index + direction;
  if (index < 0 || next < 0 || next >= order.length) return [...order];
  const result = [...order];
  [result[index], result[next]] = [result[next], result[index]];
  return result;
}
export function validHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
export function colorWithOpacity(hex: string, opacity: number): string {
  const safe = validHex(hex) ? hex : "#121625";
  const value = Math.max(
    0,
    Math.min(1, Number.isFinite(opacity) ? opacity : 1)
  );
  return `${safe}${Math.round(value * 255)
    .toString(16)
    .padStart(2, "0")}`;
}
export function validateProfileDraft(profile: Profile): string | null {
  const limits = PROFILE_TEXT_LIMITS;
  for (const key of [
    "displayName",
    "headline",
    "bio",
    "pronouns",
    "status",
    "statusEmoji",
  ] as const) {
    if (profile[key].length > limits[key])
      return `${key} is too long (maximum ${limits[key]} characters).`;
  }
  if (
    [
      profile.displayName,
      profile.headline,
      profile.bio,
      profile.pronouns,
      profile.status,
      ...profile.games,
      ...profile.platforms,
      ...profile.links.map(link => link.label),
    ].some(text =>
      /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    )
  )
    return "Use plain text without markup or control characters.";
  for (const key of [
    "backgroundColor",
    "backgroundColor2",
    "accentColor",
    "secondaryColor",
    "textColor",
    "cardColor",
  ] as const)
    if (!validHex(profile.theme[key]))
      return "Use a complete six-digit hex color for every profile color.";
  if (!profile.displayName.trim()) return "Add a display name before saving.";
  if (!profile.roles.length) return "Choose at least one role.";
  if (profile.links.length > PROFILE_LIMITS.links)
    return "Add up to eight links.";
  if (
    profile.links.some(
      link =>
        !link.label.trim() ||
        link.label.length > limits.linkLabel ||
        link.url.length > limits.linkUrl ||
        !safeSocialUrl(link.url)
    )
  )
    return "Each link needs a label and a valid https:// address, without login credentials.";
  if (
    profile.games.length > limits.tags ||
    profile.platforms.length > limits.tags ||
    profile.games.some(item => !item.trim() || item.length > limits.game) ||
    profile.platforms.some(
      item => !item.trim() || item.length > limits.platform
    )
  )
    return "Check your games and platforms: up to 20 of each, with names of at most 80 characters.";
  if (
    profile.theme.backgroundMode === "image" &&
    profile.media.background?.kind !== "image"
  )
    return "Upload a background image, or choose a different background style.";
  if (
    profile.theme.backgroundMode === "video" &&
    profile.media.background?.kind !== "video"
  )
    return "Upload a background video, or choose a different background style.";
  return validateWorldDraft(profile.world);
}

// Declarative controls keep all appearance/privacy fields auditable against the typed model.
export type ThemeFieldSpec =
  | {
      kind: "color";
      key:
        | "backgroundColor"
        | "backgroundColor2"
        | "accentColor"
        | "secondaryColor"
        | "textColor"
        | "cardColor";
      label: string;
    }
  | {
      kind: "range";
      key:
        | "cardOpacity"
        | "backgroundOpacity"
        | "overlayOpacity"
        | "backgroundBlur"
        | "ghostOpacity";
      label: string;
      max: number;
      step: number;
    }
  | {
      kind: "select";
      key:
        | "backgroundMode"
        | "font"
        | "layout"
        | "corners"
        | "glow"
        | "backgroundSize"
        | "backgroundPosition"
        | "ghostPosition"
        | "ghostSize";
      label: string;
      options: readonly string[];
      names?: Record<string, string>;
    };
export const THEME_COLORS: ThemeFieldSpec[] = [
  {
    kind: "select",
    key: "backgroundMode",
    label: "Background style",
    options: ["solid", "gradient", "image", "video"],
  },
  { kind: "color", key: "backgroundColor", label: "Base background" },
  { kind: "color", key: "backgroundColor2", label: "Gradient end" },
  { kind: "color", key: "accentColor", label: "Accent" },
  { kind: "color", key: "secondaryColor", label: "Secondary accent" },
  { kind: "color", key: "textColor", label: "Profile text" },
  { kind: "color", key: "cardColor", label: "Cards" },
  {
    kind: "range",
    key: "cardOpacity",
    label: "Card opacity",
    max: 1,
    step: 0.01,
  },
];
export const THEME_SHAPE: ThemeFieldSpec[] = [
  {
    kind: "select",
    key: "font",
    label: "Font",
    options: ["space", "inter", "mono"],
    names: {
      space: "Space Grotesk · expressive",
      inter: "Inter · clean",
      mono: "Monospace · terminal",
    },
  },
  {
    kind: "select",
    key: "layout",
    label: "Layout",
    options: ["classic", "spotlight", "compact"],
  },
  {
    kind: "select",
    key: "corners",
    label: "Card corners",
    options: ["square", "rounded", "soft"],
  },
  {
    kind: "select",
    key: "glow",
    label: "Accent glow",
    options: ["none", "subtle", "strong"],
  },
];
export const THEME_BACKGROUND: ThemeFieldSpec[] = [
  THEME_COLORS[0],
  {
    kind: "range",
    key: "backgroundOpacity",
    label: "Background opacity",
    max: 1,
    step: 0.01,
  },
  {
    kind: "range",
    key: "overlayOpacity",
    label: "Dark overlay",
    max: 1,
    step: 0.01,
  },
  {
    kind: "range",
    key: "backgroundBlur",
    label: "Background blur",
    max: 24,
    step: 1,
  },
  {
    kind: "select",
    key: "backgroundSize",
    label: "Background sizing",
    options: ["cover", "contain", "tile"],
  },
  {
    kind: "select",
    key: "backgroundPosition",
    label: "Background position",
    options: ["top", "center", "bottom"],
  },
];
export const THEME_GHOST: ThemeFieldSpec[] = [
  {
    kind: "range",
    key: "ghostOpacity",
    label: "Ghost opacity",
    max: 1,
    step: 0.01,
  },
  {
    kind: "select",
    key: "ghostPosition",
    label: "Ghost position",
    options: ["center", "top-left", "top-right", "bottom-left", "bottom-right"],
  },
  {
    kind: "select",
    key: "ghostSize",
    label: "Ghost size",
    options: ["small", "medium", "large"],
  },
];
export const SOCIAL_SETTINGS = [
  {
    key: "allowFollow",
    label: "Allow new followers",
    detail:
      "Existing followers can always unfollow. Turning this off stops new follows.",
  },
  {
    key: "allowComments",
    label: "Allow comments on my posts",
    detail:
      "Applies to your regular posts, with their original audience checks.",
  },
  {
    key: "allowReactions",
    label: "Allow reactions on my posts",
    detail: "People can still remove their existing reactions.",
  },
  {
    key: "showFollowerCount",
    label: "Show follower counts",
    detail:
      "Hide your follower count from other people. You can still see your own.",
  },
] as const;
export const MOTION_SETTINGS = [
  {
    key: "reducedMotion",
    label: "Reduce profile motion",
    detail:
      "Start decorative video paused. Manual playback remains your choice.",
  },
  {
    key: "autoplayBackground",
    label: "Autoplay silent background",
    detail:
      "Off by default. Only works when neither this profile nor the visitor’s device requests reduced motion. The editor always starts with a poster.",
  },
] as const;

// Small editor primitives use createElement so this shared helper remains a .ts module.
// No browser globals, effects, networking, or styles are evaluated when helpers are imported in tests.
export function EditorSection({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return h(
    "section",
    { className: "profile-editor-section" },
    h("h2", null, title),
    detail && h("p", { className: "profile-help" }, detail),
    h("div", { className: "profile-editor-section-body" }, children)
  );
}
export function TextField({
  label,
  value,
  onChange,
  max,
  placeholder,
  required,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return h(
    "label",
    { className: "profile-field" },
    h("span", null, label),
    h("input", {
      type,
      value,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        onChange(event.target.value),
      maxLength: max,
      placeholder,
      required,
      autoComplete: "off",
    })
  );
}
export function SelectField({
  label,
  value,
  options,
  onChange,
  names = {},
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  names?: Record<string, string>;
}) {
  return h(
    "label",
    { className: "profile-field" },
    h("span", null, label),
    h(
      "select",
      {
        value,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value),
      },
      options.map(option =>
        h(
          "option",
          { key: option, value: option },
          names[option] ||
            option[0].toUpperCase() + option.slice(1).replaceAll("-", " ")
        )
      )
    )
  );
}
export function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  percent,
  unit = "",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  percent?: boolean;
  unit?: string;
}) {
  return h(
    "label",
    { className: "profile-field profile-range" },
    h(
      "span",
      null,
      label,
      h(
        "output",
        null,
        percent ? `${Math.round(value * 100)}%` : `${value}${unit}`
      )
    ),
    h("input", {
      type: "range",
      value,
      min,
      max,
      step,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        onChange(Number(event.target.value)),
    })
  );
}
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return h(
    "div",
    { className: "profile-field" },
    h("span", null, label),
    h(
      "div",
      { className: "profile-color-control" },
      h("input", {
        type: "color",
        "aria-label": `${label} color picker`,
        value: validHex(value) ? value : "#121625",
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value),
      }),
      h("input", {
        "aria-label": `${label} hex color`,
        value,
        maxLength: 7,
        pattern: "#[0-9a-fA-F]{6}",
        title: "A six-digit hex color, such as #00e5ff",
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value),
        spellCheck: false,
      })
    )
  );
}
export function ToggleField({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return h(
    "label",
    { className: "profile-toggle" },
    h("span", null, h("strong", null, label), h("small", null, detail)),
    h("input", {
      type: "checkbox",
      checked,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        onChange(event.target.checked),
    })
  );
}
export function TagField({
  label,
  values,
  onChange,
  maxLength,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  maxLength: number;
}) {
  const [text, setText] = useState("");
  function add() {
    const next = text.trim();
    if (
      !next ||
      values.length >= PROFILE_TEXT_LIMITS.tags ||
      values.some(
        value => value.toLocaleLowerCase() === next.toLocaleLowerCase()
      )
    )
      return;
    onChange([...values, next]);
    setText("");
  }
  return h(
    "div",
    { className: "profile-field" },
    h(
      "label",
      null,
      h(
        "span",
        null,
        label,
        " ",
        h("small", null, `${values.length} / ${PROFILE_TEXT_LIMITS.tags}`)
      ),
      h(
        "div",
        { className: "profile-tag-input" },
        h("input", {
          value: text,
          maxLength,
          placeholder: `Add ${label.toLowerCase()}`,
          onChange: (event: ChangeEvent<HTMLInputElement>) =>
            setText(event.target.value),
          onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          },
        }),
        h(
          "button",
          {
            type: "button",
            className: "profile-icon-button",
            "aria-label": `Add to ${label.toLowerCase()}`,
            disabled: !text.trim() || values.length >= PROFILE_TEXT_LIMITS.tags,
            onClick: add,
          },
          h(Plus, { size: 19 })
        )
      )
    ),
    h(
      "div",
      { className: "profile-edit-tags" },
      values.map(value =>
        h(
          "span",
          { key: value },
          value,
          h(
            "button",
            {
              type: "button",
              "aria-label": `Remove ${value} from ${label.toLowerCase()}`,
              onClick: () => onChange(values.filter(item => item !== value)),
            },
            h(X, { size: 13 })
          )
        )
      )
    )
  );
}
export function ThemeFields({
  fields,
  value,
  onChange,
}: {
  fields: ThemeFieldSpec[];
  value: ProfileTheme;
  onChange: (change: Partial<ProfileTheme>) => void;
}) {
  return h(
    Fragment,
    null,
    fields.map(spec =>
      spec.kind === "color"
        ? h(ColorField, {
            key: spec.key,
            label: spec.label,
            value: value[spec.key],
            onChange: next => onChange({ [spec.key]: next }),
          })
        : spec.kind === "range"
          ? h(RangeField, {
              key: spec.key,
              label: spec.label,
              value: value[spec.key],
              min: 0,
              max: spec.max,
              step: spec.step,
              percent: spec.max === 1,
              unit: spec.max === 1 ? "" : "px",
              onChange: next => onChange({ [spec.key]: next }),
            })
          : h(SelectField, {
              key: spec.key,
              label: spec.label,
              value: value[spec.key],
              options: spec.options,
              names: spec.names,
              onChange: next => onChange({ [spec.key]: next }),
            })
    )
  );
}

export const PROFILE_PALETTES = [
  {
    name: "Neon arcade",
    colors: ["#090b14", "#211038", "#00e5ff", "#ff3da6", "#f2f5ff", "#121625"],
  },
  {
    name: "Toxic bloom",
    colors: ["#0b140e", "#15352b", "#b6ff3b", "#00e5bd", "#eeffed", "#14221a"],
  },
  {
    name: "After hours",
    colors: ["#170c21", "#3e1631", "#ff80d5", "#b391ff", "#fff0fc", "#26152f"],
  },
  {
    name: "Cloud save",
    colors: ["#e7eef8", "#d6dcf3", "#284ec9", "#a3237e", "#16223e", "#ffffff"],
  },
  {
    name: "Solar flare",
    colors: ["#1a0e09", "#442019", "#ffbc66", "#ff657c", "#fff4e8", "#2b1914"],
  },
] as const;
