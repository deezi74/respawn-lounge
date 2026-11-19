import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Eye,
  ImagePlus,
  Loader2,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Shield,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { api, errorMessage, patch, useData, useRefresh } from "@/lib/app-api";
import { startLogin } from "@/const";
import {
  AVATAR_EMOJIS,
  PROFILE_LIMITS,
  PROFILE_ROLES,
  defaultProfile,
  type Profile,
  type ProfileAsset,
  type ProfileSettings,
  type ProfileTheme,
} from "@shared/profile-types";
import {
  PROFILE_SECTION_LABELS as ProfileSectionLabels,
  ProfileSurface,
  ProfileState,
} from "./Profile";
import { ProfileMediaUpload as UploadField } from "./MemberAvatar";
import { EmojiPicker } from "./EmojiPicker";
import { insertEmoji } from "./emoji-utils";

import {
  PROFILE_TEXT_LIMITS as LIMITS,
  moveProfileModule,
  profileInput,
  profileMediaForm,
  profileMediaUrl,
  profileUploadError,
  validateProfileDraft,
  type ProfileSlot,
  THEME_COLORS,
  THEME_SHAPE,
  THEME_BACKGROUND,
  THEME_GHOST,
  SOCIAL_SETTINGS,
  MOTION_SETTINGS,
  EditorSection,
  TextField,
  SelectField,
  ToggleField,
  TagField,
  ThemeFields,
  PROFILE_PALETTES as PALETTES,
} from "./profile-utils";
import "./profile.css";

type EditorTab = "identity" | "appearance" | "media" | "privacy";
const TABS = [
  { key: "identity", label: "Identity", icon: UserRound },
  { key: "appearance", label: "Appearance", icon: Palette },
  { key: "media", label: "Artwork", icon: ImagePlus },
  { key: "privacy", label: "Privacy", icon: Shield },
] as const;

export default function ProfileEditor() {
  const { user, loading } = useAuth();
  const query = useData<Profile>("/profile/me", Boolean(user));
  if (loading) return <ProfileState title="Opening your studio…" />;
  if (!user)
    return (
      <ProfileState
        title="Make yourself at home."
        detail="Sign in to create and save your personal world."
      >
        <button className="profile-button profile-primary" onClick={() => startLogin()}>
          Sign in to customize
        </button>
      </ProfileState>
    );
  if (query.data?.ownerId === user.id)
    return <EditorWorkspace key={user.id} initial={query.data} />;
  if (query.error)
    return (
      <ProfileState title="Your profile couldn’t be loaded." detail={errorMessage(query.error)}>
        <button className="profile-button" onClick={() => void query.refetch()}>
          Try again
        </button>
      </ProfileState>
    );
  return <ProfileState title="Loading your profile…" />;
}

function EditorWorkspace({ initial }: { initial: Profile }) {
  // Deliberately initialize once per account, never from the ten-second query updates.
  const [draft, setDraft] = useState<Profile>(() => structuredClone(initial));
  const [baseline, setBaseline] = useState<Profile>(() => structuredClone(initial));
  const [tab, setTab] = useState<EditorTab>("identity");
  const [saving, setSaving] = useState(false),
    [uploading, setUploading] = useState<ProfileSlot | null>(null);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const lock = useRef(false),
    active = useRef(true),
    abort = useRef<AbortController | null>(null);
  const refresh = useRefresh();
  const formId = useId();
  const busy = saving || uploading !== null;
  const dirty = JSON.stringify(profileInput(draft)) !== JSON.stringify(profileInput(baseline));
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = (event.target as Element)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      if (
        !window.confirm(
          busy
            ? "An upload or save is still running. Leave the editor?"
            : "Leave without saving your profile changes?"
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const editorUrl = window.location.href;
    const pop = (event: PopStateEvent) => {
      const destination = new URL(window.location.href);
      const current = new URL(editorUrl);
      if (destination.pathname === current.pathname && destination.search === current.search)
        return;
      if (
        window.confirm(
          busy
            ? "An upload or save is still running. Leave the editor?"
            : "Leave without saving your profile changes?"
        )
      )
        return;
      // popstate is not cancelable. Restore the editor URL before the router observes it.
      event.stopImmediatePropagation();
      window.history.pushState(window.history.state, "", editorUrl);
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("popstate", pop, true);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("popstate", pop, true);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty, busy]);
  function field<K extends keyof Profile>(key: K, value: Profile[K]) {
    if (lock.current) return;
    setDraft(previous => ({ ...previous, [key]: value }));
    setNotice("");
  }
  function theme<K extends keyof ProfileTheme>(key: K, value: ProfileTheme[K]) {
    if (lock.current) return;
    setDraft(previous => ({
      ...previous,
      theme: { ...previous.theme, [key]: value },
    }));
    setNotice("");
  }
  function setting<K extends keyof ProfileSettings>(key: K, value: ProfileSettings[K]) {
    if (lock.current) return;
    setDraft(previous => ({
      ...previous,
      settings: { ...previous.settings, [key]: value },
    }));
    setNotice("");
  }
  async function upload(slot: ProfileSlot, file: File) {
    if (lock.current) return;
    const problem = profileUploadError(file, slot);
    if (problem) {
      setError(problem);
      return;
    }
    lock.current = true;
    setUploading(slot);
    setError(null);
    setNotice("");
    abort.current = new AbortController();
    try {
      const asset = await api<ProfileAsset>("/profile/media", {
        method: "POST",
        body: profileMediaForm(file, slot),
        signal: abort.current.signal,
      });
      if (!active.current) return;
      if (
        !profileMediaUrl(asset.id, asset.url, window.location.origin) ||
        !["image", "video"].includes(asset.kind) ||
        (slot !== "background" && asset.kind !== "image") ||
        (asset.kind === "video" &&
          !profileMediaUrl(asset.id, asset.posterUrl, window.location.origin, true))
      )
        throw new Error(
          "The upload response did not contain safe profile artwork. Your existing artwork is unchanged."
        );
      setDraft(previous => ({
        ...previous,
        [`${slot}MediaId`]: asset.id,
        media: { ...previous.media, [slot]: asset },
        ...(slot === "background"
          ? { theme: { ...previous.theme, backgroundMode: asset.kind } }
          : {}),
      }));
      setNotice(
        "Artwork uploaded to your private draft. Save profile to apply it to the selected audience."
      );
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
    } finally {
      if (active.current) {
        lock.current = false;
        setUploading(null);
      }
    }
  }
  function remove(slot: ProfileSlot) {
    if (lock.current) return;
    setDraft(previous => {
      const media = { ...previous.media };
      delete media[slot];
      return {
        ...previous,
        [`${slot}MediaId`]: null,
        media,
        ...(slot === "background"
          ? {
              theme: { ...previous.theme, backgroundMode: "gradient" as const },
            }
          : {}),
      };
    });
    setNotice(
      "Removed from your local draft. Save to apply; this does not promise physical deletion of stored files."
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    if (!refreshPending) {
      const problem = validateProfileDraft(draft);
      if (problem) {
        setError(problem);
        return;
      }
    }
    lock.current = true;
    setSaving(true);
    setError(null);
    setNotice("");
    let saved = refreshPending;
    try {
      if (!refreshPending) {
        const result = await patch<Profile>("/profile/me", {
          ...profileInput(draft),
          confirmed: true,
        });
        if (!active.current) return;
        setBaseline(structuredClone(result));
        setDraft(structuredClone(result));
        saved = true;
        setRefreshPending(true);
      }
      await refresh();
      if (!active.current) return;
      setRefreshPending(false);
      setNotice("Saved. Your profile now uses the visibility and settings you selected.");
    } catch (cause) {
      if (active.current)
        setError(
          saved
            ? `Your profile was saved, but refreshing failed. ${errorMessage(cause)} Use Finish refresh; your profile will not be submitted again.`
            : errorMessage(cause)
        );
    } finally {
      if (active.current) {
        lock.current = false;
        setSaving(false);
      }
    }
  }
  function reset() {
    if (
      lock.current ||
      !window.confirm(
        "Reset this entire local draft to the default profile? Nothing changes for visitors until you save."
      )
    )
      return;
    setDraft(defaultProfile(initial.ownerId, initial.displayName));
    setError(null);
    setNotice("Default profile loaded into your local draft only. Save to apply.");
  }
  const visibilityLabel =
    draft.settings.visibility === "public"
      ? "Public"
      : draft.settings.visibility === "members"
        ? "Members only"
        : "Only you";
  return (
    <div className="profile-editor">
      <Link className="profile-back" href="/profile">
        <ArrowLeft size={16} />
        Back to my world
      </Link>
      <header className="profile-editor-heading">
        <div>
          <span className="profile-eyebrow">YOUR WORLD / YOUR RULES</span>
          <h1>
            Make it feel like <span>you.</span>
          </h1>
          <p>Everything is a local draft until you choose Save profile.</p>
        </div>
        <span className={`profile-draft-status${dirty ? " profile-is-dirty" : ""}`}>
          <span />
          {busy
            ? "Working…"
            : dirty
              ? "Unsaved changes"
              : baseline.saved
                ? "Saved profile"
                : "Not saved yet"}
        </span>
      </header>
      <div className="profile-editor-workspace">
        <div className="profile-editor-controls">
          <div
            className="profile-editor-tabs"
            role="tablist"
            aria-label="Profile editor categories"
          >
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                type="button"
                role="tab"
                key={key}
                id={`${formId}-${key}-tab`}
                aria-selected={tab === key}
                aria-controls={`${formId}-${key}-panel`}
                tabIndex={tab === key ? 0 : -1}
                onKeyDown={event => {
                  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const index = TABS.findIndex(item => item.key === tab);
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) %
                          TABS.length;
                  setTab(TABS[next].key);
                  document.getElementById(`${formId}-${TABS[next].key}-tab`)?.focus();
                }}
                onClick={() => setTab(key)}
              >
                <Icon size={17} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <form id={formId} onSubmit={save}>
            <fieldset disabled={busy || refreshPending} className="profile-editor-fieldset">
              <div
                role="tabpanel"
                id={`${formId}-${tab}-panel`}
                aria-labelledby={`${formId}-${tab}-tab`}
                className="profile-editor-panel"
              >
                {tab === "identity" && (
                  <>
                    <EditorSection
                      title="The player behind the profile"
                      detail="Your name and a little of your personality."
                    >
                      <TextField
                        label="Display name"
                        value={draft.displayName}
                        onChange={value => field("displayName", value)}
                        max={LIMITS.displayName}
                        required
                      />
                      <TextField
                        label="Headline"
                        value={draft.headline}
                        onChange={value => field("headline", value)}
                        max={LIMITS.headline}
                        placeholder="Your vibe in one line"
                      />
                      <TextField
                        label="Pronouns"
                        value={draft.pronouns}
                        onChange={value => field("pronouns", value)}
                        max={LIMITS.pronouns}
                        placeholder="Optional"
                      />
                      <div className="profile-field">
                        <span>I’m here as</span>
                        <div className="profile-role-choices">
                          {PROFILE_ROLES.map(role => (
                            <label key={role}>
                              <input
                                type="checkbox"
                                checked={draft.roles.includes(role)}
                                onChange={event =>
                                  field(
                                    "roles",
                                    event.target.checked
                                      ? [...draft.roles, role]
                                      : draft.roles.filter(value => value !== role)
                                  )
                                }
                              />
                              {role}
                            </label>
                          ))}
                        </div>
                        <small>Choose one, two, or all three.</small>
                      </div>
                      <label className="profile-field">
                        <span>
                          Bio{" "}
                          <small>
                            {draft.bio.length} / {LIMITS.bio}
                          </small>
                        </span>
                        <textarea
                          rows={5}
                          value={draft.bio}
                          maxLength={LIMITS.bio}
                          placeholder="The games you love. The things you make. The person you are."
                          onChange={event => field("bio", event.target.value)}
                        />
                      </label>
                      <EmojiPicker
                        disabled={busy}
                        label="Add emoji to bio"
                        onSelect={emoji =>
                          field(
                            "bio",
                            insertEmoji(
                              draft.bio,
                              emoji,
                              draft.bio.length,
                              draft.bio.length,
                              LIMITS.bio
                            ).value
                          )
                        }
                      />
                    </EditorSection>
                    <EditorSection
                      title="Current status"
                      detail="A small signal, not a live presence indicator."
                    >
                      <div className="profile-status-edit">
                        <span
                          className="profile-status-emoji"
                          aria-label={`Status emoji ${draft.statusEmoji}`}
                        >
                          {draft.statusEmoji || "—"}
                        </span>
                        <EmojiPicker
                          disabled={busy}
                          label="Choose status emoji"
                          onSelect={emoji => field("statusEmoji", emoji)}
                        />
                        <button
                          className="profile-icon-button"
                          type="button"
                          aria-label="Clear status emoji"
                          onClick={() => field("statusEmoji", "")}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <TextField
                        label="Status"
                        value={draft.status}
                        onChange={value => field("status", value)}
                        max={LIMITS.status}
                        placeholder="One more match…"
                      />
                      <EmojiPicker
                        disabled={busy}
                        label="Add emoji to status"
                        onSelect={emoji =>
                          field(
                            "status",
                            insertEmoji(
                              draft.status,
                              emoji,
                              draft.status.length,
                              draft.status.length,
                              LIMITS.status
                            ).value
                          )
                        }
                      />
                    </EditorSection>
                    <EditorSection
                      title="Your loadout"
                      detail="Add your own games and platforms; no preset boxes to fit into."
                    >
                      <TagField
                        label="Games"
                        values={draft.games}
                        maxLength={LIMITS.game}
                        onChange={values => field("games", values)}
                      />
                      <TagField
                        label="Platforms"
                        values={draft.platforms}
                        maxLength={LIMITS.platform}
                        onChange={values => field("platforms", values)}
                      />
                    </EditorSection>
                    <EditorSection
                      title="Find me elsewhere"
                      detail={`Up to ${PROFILE_LIMITS.links} channels or social links. HTTPS only.`}
                    >
                      {draft.links.map((link, index) => (
                        <div className="profile-link-edit" key={index}>
                          <TextField
                            label={`Link ${index + 1} label`}
                            value={link.label}
                            max={LIMITS.linkLabel}
                            onChange={value =>
                              field(
                                "links",
                                draft.links.map((item, i) =>
                                  i === index ? { ...item, label: value } : item
                                )
                              )
                            }
                            placeholder="Channel or social name"
                          />
                          <TextField
                            label={`Link ${index + 1} HTTPS address`}
                            value={link.url}
                            max={LIMITS.linkUrl}
                            type="url"
                            onChange={value =>
                              field(
                                "links",
                                draft.links.map((item, i) =>
                                  i === index ? { ...item, url: value } : item
                                )
                              )
                            }
                            placeholder="https://…"
                          />
                          <button
                            className="profile-button"
                            type="button"
                            onClick={() =>
                              field(
                                "links",
                                draft.links.filter((_, i) => i !== index)
                              )
                            }
                          >
                            <Trash2 size={15} />
                            Remove link {index + 1}
                          </button>
                        </div>
                      ))}
                      <button
                        className="profile-button"
                        type="button"
                        disabled={draft.links.length >= PROFILE_LIMITS.links}
                        onClick={() => field("links", [...draft.links, { label: "", url: "" }])}
                      >
                        <Plus size={16} />
                        Add link <span>{draft.links.length} / 8</span>
                      </button>
                    </EditorSection>
                  </>
                )}
                {tab === "appearance" && (
                  <>
                    <EditorSection
                      title="Pick a starting frequency"
                      detail="Presets change colors only. Fine-tune every color below."
                    >
                      <div className="profile-palettes">
                        {PALETTES.map(palette => (
                          <button
                            key={palette.name}
                            type="button"
                            onClick={() => {
                              const [
                                backgroundColor,
                                backgroundColor2,
                                accentColor,
                                secondaryColor,
                                textColor,
                                cardColor,
                              ] = palette.colors;
                              field("theme", {
                                ...draft.theme,
                                backgroundColor,
                                backgroundColor2,
                                accentColor,
                                secondaryColor,
                                textColor,
                                cardColor,
                              });
                            }}
                          >
                            <span>
                              {palette.colors.slice(0, 4).map(color => (
                                <i key={color} style={{ background: color }} />
                              ))}
                            </span>
                            {palette.name}
                          </button>
                        ))}
                      </div>
                    </EditorSection>
                    <EditorSection
                      title="Color your world"
                      detail="Any six-digit hex color is yours to use. Check your live preview for readable contrast."
                    >
                      <ThemeFields
                        fields={THEME_COLORS}
                        value={draft.theme}
                        onChange={change => field("theme", { ...draft.theme, ...change })}
                      />
                      <p className="profile-help">
                        Image and video styles use your uploaded background in Artwork. Video stays
                        silent.
                      </p>
                    </EditorSection>
                    <EditorSection title="Shape & personality">
                      <ThemeFields
                        fields={THEME_SHAPE}
                        value={draft.theme}
                        onChange={change => field("theme", { ...draft.theme, ...change })}
                      />
                    </EditorSection>
                    <EditorSection
                      title="Arrange your world"
                      detail="Show, hide, and move all five sections. Hiding a section is appearance only, not an access restriction."
                    >
                      <div className="profile-section-order">
                        {draft.theme.moduleOrder.map((module, index) => (
                          <div key={module}>
                            <label>
                              <input
                                type="checkbox"
                                checked={draft.theme.modules[module]}
                                onChange={event =>
                                  theme("modules", {
                                    ...draft.theme.modules,
                                    [module]: event.target.checked,
                                  })
                                }
                              />
                              <span>{ProfileSectionLabels[module]}</span>
                            </label>
                            {([-1, 1] as const).map(direction => (
                              <button
                                key={direction}
                                type="button"
                                className="profile-icon-button"
                                disabled={
                                  direction === -1
                                    ? index === 0
                                    : index === draft.theme.moduleOrder.length - 1
                                }
                                aria-label={`Move ${ProfileSectionLabels[module]} ${direction === -1 ? "up" : "down"}`}
                                onClick={() =>
                                  theme(
                                    "moduleOrder",
                                    moveProfileModule(draft.theme.moduleOrder, module, direction)
                                  )
                                }
                              >
                                {direction === -1 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </EditorSection>
                  </>
                )}
                {tab === "media" && (
                  <>
                    <EditorSection
                      title="Choose your avatar"
                      detail="30 original emoji options, or upload your own image."
                    >
                      <div className="profile-avatar-choices">
                        {AVATAR_EMOJIS.map(emoji => (
                          <button
                            type="button"
                            key={emoji}
                            aria-label={`Use ${emoji} avatar`}
                            aria-pressed={!draft.avatarMediaId && draft.avatarEmoji === emoji}
                            onClick={() => {
                              field("avatarEmoji", emoji);
                              remove("avatar");
                            }}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      <UploadField
                        slot="avatar"
                        profile={draft}
                        busy={busy}
                        uploading={uploading}
                        onUpload={upload}
                        onRemove={remove}
                      />
                    </EditorSection>
                    {(["banner", "background", "ghost"] as const).map(slot => (
                      <EditorSection
                        key={slot}
                        title={
                          slot === "banner"
                            ? "Give your world a cover"
                            : slot === "background"
                              ? "Set the scene"
                              : "A ghost in the background"
                        }
                        detail={
                          slot === "banner"
                            ? "JPEG, PNG or WebP, up to 8 MiB. Sanitized and stripped of metadata."
                            : slot === "background"
                              ? "Artwork up to 8 MiB; MP4 or WebM up to 20 MiB / 30 seconds. Video is processed to silent playback with a poster."
                              : "A separate faded image, layered behind your profile content."
                        }
                      >
                        <UploadField
                          slot={slot}
                          profile={draft}
                          busy={busy}
                          uploading={uploading}
                          onUpload={upload}
                          onRemove={remove}
                        />
                        {slot !== "banner" && (
                          <ThemeFields
                            fields={slot === "background" ? THEME_BACKGROUND : THEME_GHOST}
                            value={draft.theme}
                            onChange={change => field("theme", { ...draft.theme, ...change })}
                          />
                        )}
                        {slot === "background" && (
                          <p className="profile-help">
                            Tile repeats static artwork; video uses Cover for Tile.
                          </p>
                        )}
                      </EditorSection>
                    ))}
                  </>
                )}
                {tab === "privacy" && (
                  <>
                    <EditorSection
                      title="Who can enter your world?"
                      detail="This controls your profile page and its artwork, not the audiences of posts you already shared."
                    >
                      <SelectField
                        label="Profile visibility"
                        value={draft.settings.visibility}
                        options={["public", "members", "private"]}
                        names={{
                          public: "Public · anyone can visit",
                          members: "Members · signed-in people only",
                          private: "Private · only you",
                        }}
                        onChange={value =>
                          setting("visibility", value as ProfileSettings["visibility"])
                        }
                      />
                      <ToggleField
                        label="Appear in People"
                        detail={
                          draft.settings.visibility === "private"
                            ? "Private profiles are never listed, even with this enabled."
                            : "Allow this saved profile to appear in member search."
                        }
                        checked={draft.settings.discoverable}
                        onChange={value => setting("discoverable", value)}
                      />
                    </EditorSection>
                    <EditorSection title="Your social boundaries">
                      {SOCIAL_SETTINGS.map(item => (
                        <ToggleField
                          key={item.key}
                          label={item.label}
                          detail={item.detail}
                          checked={draft.settings[item.key]}
                          onChange={value => setting(item.key, value)}
                        />
                      ))}
                    </EditorSection>
                    <EditorSection title="Keep motion comfortable">
                      {MOTION_SETTINGS.map(item => (
                        <ToggleField
                          key={item.key}
                          label={item.label}
                          detail={item.detail}
                          checked={draft.settings[item.key]}
                          onChange={value => setting(item.key, value)}
                        />
                      ))}
                    </EditorSection>
                    <div className="profile-privacy-note">
                      <Shield size={21} />
                      <div>
                        <strong>Post audiences are independent.</strong>
                        <p>
                          A private profile does not make public posts private. Lounge posts still
                          require their own access. Hiding a profile section does not hide its posts
                          or clips elsewhere. Your Clip Tray is separate and private.
                        </p>
                      </div>
                    </div>
                    <EditorSection
                      title="A fresh start"
                      detail="This resets only the local draft, including selected artwork. Your saved profile stays unchanged until Save."
                    >
                      <button
                        className="profile-button profile-danger"
                        type="button"
                        onClick={reset}
                      >
                        <RotateCcw size={15} />
                        Reset entire local draft
                      </button>
                    </EditorSection>
                  </>
                )}
              </div>
            </fieldset>
          </form>
          <div className="profile-editor-save">
            {error && (
              <div className="profile-error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <p className="profile-save-notice" role="status">
                <Check size={16} />
                {notice}
              </p>
            )}
            <p>
              <Shield size={14} />
              Save applies this full profile to: <strong>{visibilityLabel}</strong>
            </p>
            <button
              className="profile-button profile-primary"
              type="submit"
              form={formId}
              disabled={busy}
            >
              {busy ? <Loader2 size={17} className="profile-spin" /> : <Save size={17} />}
              {uploading
                ? `Uploading ${uploading}…`
                : saving
                  ? "Saving…"
                  : refreshPending
                    ? "Finish refresh"
                    : "Save profile"}
            </button>
            <button
              className="profile-button"
              type="button"
              disabled={busy || refreshPending || !dirty}
              onClick={() => {
                if (
                  window.confirm("Discard local changes and return to your last saved profile?")
                ) {
                  setDraft(structuredClone(baseline));
                  setError(null);
                  setNotice("Local changes discarded. Your saved profile is unchanged.");
                }
              }}
            >
              <RotateCcw size={15} />
              Discard local changes
            </button>
          </div>
        </div>
        <aside className="profile-preview-pane" aria-label="Live profile preview">
          <div className="profile-preview-heading">
            <span>
              <Eye size={16} />
              LIVE PREVIEW
            </span>
            <span>Local draft · {visibilityLabel}</span>
          </div>
          <ProfileSurface profile={draft} own preview />
          <p className="profile-preview-footnote">
            The real profile surface, with your real posts and published clips. Preview controls
            don’t publish or follow anyone.
          </p>
        </aside>
      </div>
    </div>
  );
}
