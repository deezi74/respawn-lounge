import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  ArrowDown,
  ArrowUp,
  ImagePlus,
  Loader2,
  Music2,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { api, errorMessage, useData } from "@/lib/app-api";
import { canViewProfile, type Profile } from "@shared/profile-types";
import {
  WORLD_LIMITS,
  type ProfileWorld,
  type WorldAsset,
} from "@shared/profile-world-types";
import { ProfileAvatar } from "./MemberAvatar";
import { WorldImage } from "./ProfileWorld";
import {
  ColorField,
  EditorSection,
  SelectField,
  TagField,
  TextField,
} from "./profile-utils";
import {
  chromeProfilePreset,
  moveWorldItem,
  validWorldAsset,
  worldFileTitle,
  worldMediaForm,
  worldUploadError,
  WORLD_SECTION_LABELS,
  WORLD_TEXT_LIMITS as L,
  type WorldSlot,
} from "./world-utils";

type Upload = (
  slot: WorldSlot,
  file: File,
  rightsConfirmed?: boolean
) => Promise<void>;
type UploadContext = {
  lock: { current: boolean };
  active: { current: boolean };
  abort: { current: AbortController | null };
  setDraft: Dispatch<SetStateAction<Profile>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string>>;
};
/** Shares the workspace's synchronous lock and abort lifecycle with all older uploads and Save. */
export function useWorldUpload({
  lock,
  active,
  abort,
  setDraft,
  setError,
  setNotice,
}: UploadContext) {
  const [worldUploading, setUploading] = useState<WorldSlot | null>(null);
  const uploadWorld: Upload = async (slot, file, rightsConfirmed = false) => {
    if (lock.current) return;
    const problem = worldUploadError(file, slot, rightsConfirmed);
    if (problem) {
      setError(problem);
      return;
    }
    lock.current = true;
    setUploading(slot);
    setError(null);
    setNotice("");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const asset = await api<WorldAsset>("/profile/world/media", {
        method: "POST",
        body: worldMediaForm(file, slot, rightsConfirmed),
        signal: controller.signal,
      });
      if (!active.current || controller.signal.aborted) return;
      if (!validWorldAsset(asset, slot, window.location.origin))
        throw new Error(
          "The upload response did not contain safe personal-page media. Your existing collection is unchanged."
        );
      setDraft(previous => {
        const world = previous.world;
        if (
          world[slot].length >=
          (slot === "music" ? WORLD_LIMITS.tracks : WORLD_LIMITS.art)
        )
          return previous;
        const title = worldFileTitle(file.name);
        const next =
          slot === "music"
            ? {
                ...world,
                music: [
                  ...world.music,
                  { title, artist: "", mediaId: asset.id },
                ],
              }
            : {
                ...world,
                art: [...world.art, { title, caption: "", mediaId: asset.id }],
              };
        return {
          ...previous,
          world: next,
          worldMedia: { ...previous.worldMedia, [asset.id]: asset },
        };
      });
      setNotice(
        "Uploaded to your private draft. Save profile to apply this collection to your selected audience."
      );
    } catch (cause) {
      if (active.current && !controller.signal.aborted)
        setError(errorMessage(cause));
    } finally {
      if (active.current) {
        lock.current = false;
        setUploading(null);
      }
    }
  };
  return { worldUploading, uploadWorld };
}

export function WorldEditor({
  draft,
  busy,
  uploading,
  onChange,
  onPreset,
  onUpload,
}: {
  draft: Profile;
  busy: boolean;
  uploading: WorldSlot | null;
  onChange: (world: ProfileWorld) => void;
  onPreset: (profile: Profile) => void;
  onUpload: Upload;
}) {
  const w = draft.world;
  function change<K extends keyof ProfileWorld>(
    key: K,
    value: ProfileWorld[K]
  ) {
    if (!busy) onChange({ ...w, [key]: value });
  }
  function remove(slot: WorldSlot, index: number) {
    if (busy) return;
    change(
      slot,
      w[slot].filter((_, i) => i !== index) as ProfileWorld[typeof slot]
    );
  }
  return (
    <div className="world-editor">
      <EditorSection
        title="A page, not just a feed"
        detail="Choose a starting composition. Your artwork, background effects and every existing section remain yours."
      >
        <button
          type="button"
          className="world-chrome-preset"
          disabled={busy}
          onClick={() => onPreset(chromeProfilePreset(draft))}
        >
          <span aria-hidden="true" className="world-preset-diagram">
            <i />
            <b />
            <em />
            <em />
          </span>
          <span>
            <strong>Blue Chrome · personal mini-site</strong>
            <small>
              Framed blue panels, large square portrait, classic columns and
              cozy width. Changes colors and composition only.
            </small>
          </span>
        </button>
        <SelectField
          label="Panel style"
          value={w.chrome}
          options={["glass", "chrome", "minimal"]}
          names={{
            glass: "Modern glass",
            chrome: "Chrome · framed headers",
            minimal: "Minimal · quiet frames",
          }}
          onChange={value => change("chrome", value as ProfileWorld["chrome"])}
        />
        <SelectField
          label="Portrait shape"
          value={w.portrait}
          options={["round", "square"]}
          onChange={value =>
            change("portrait", value as ProfileWorld["portrait"])
          }
        />
        <SelectField
          label="Page width"
          value={w.pageWidth}
          options={["wide", "cozy"]}
          onChange={value =>
            change("pageWidth", value as ProfileWorld["pageWidth"])
          }
        />
        <p className="profile-help">
          Classic layout puts the portrait beside the panels in Chrome.
          Spotlight and Compact still work; switch layouts in Appearance.
        </p>
      </EditorSection>
      <EditorSection
        title="Words to live by"
        detail="A favorite quote and its author, in plain text."
      >
        <LongField
          label="Favorite quote"
          value={w.quote}
          max={L.quote}
          onChange={value => change("quote", value)}
        />
        <TextField
          label="Quote author"
          value={w.quoteAuthor}
          max={L.quoteAuthor}
          onChange={value => change("quoteAuthor", value)}
        />
      </EditorSection>
      <EditorSection
        title="Your soundtrack"
        detail="Up to three uploaded tracks. MP3, WAV, M4A or OGG · 15 MiB · 10 minutes each. Playback is always the visitor’s choice."
      >
        <TagField
          label="Favorite music"
          values={w.favoriteMusic}
          maxLength={L.musicTag}
          onChange={values => change("favoriteMusic", values)}
        />
        {w.music.map((track, index) => (
          <div className="world-edit-item" key={track.mediaId}>
            <div className="world-edit-item-head">
              <strong>Track {index + 1}</strong>
              <OrderButtons
                label={`track ${index + 1}`}
                index={index}
                length={w.music.length}
                busy={busy}
                onMove={direction =>
                  change("music", moveWorldItem(w.music, index, direction))
                }
                onRemove={() => remove("music", index)}
              />
            </div>
            <TextField
              label={`Track ${index + 1} title`}
              value={track.title}
              max={L.title}
              onChange={title =>
                change(
                  "music",
                  w.music.map((item, i) =>
                    i === index ? { ...item, title } : item
                  )
                )
              }
            />
            <TextField
              label={`Track ${index + 1} artist / credit`}
              value={track.artist}
              max={L.artist}
              onChange={artist =>
                change(
                  "music",
                  w.music.map((item, i) =>
                    i === index ? { ...item, artist } : item
                  )
                )
              }
            />
            <p className="profile-help">
              {draft.worldMedia[track.mediaId]?.kind === "audio"
                ? `Uploaded audio · ${Math.ceil((draft.worldMedia[track.mediaId].duration || 0) / 60)} min · manual playback in preview`
                : "Audio metadata unavailable. Save checks that this is your uploaded track."}
            </p>
          </div>
        ))}
        <WorldUpload
          slot="music"
          busy={busy}
          uploading={uploading === "music"}
          full={w.music.length >= WORLD_LIMITS.tracks}
          onUpload={onUpload}
        />
        <p className="profile-help">
          Removal changes this draft only. Save updates visitors’ access; it
          does not promise physical file deletion. No external music URLs or
          bundled songs.
        </p>
      </EditorSection>
      <EditorSection
        title="Art & gallery"
        detail="Up to 12 of your own uploaded images. JPEG, PNG or WebP · 8 MiB each. No stock collection is inserted."
      >
        {w.art.map((art, index) => (
          <div className="world-edit-item" key={art.mediaId}>
            <div className="world-edit-item-head">
              <strong>Artwork {index + 1}</strong>
              <OrderButtons
                label={`artwork ${index + 1}`}
                index={index}
                length={w.art.length}
                busy={busy}
                onMove={direction =>
                  change("art", moveWorldItem(w.art, index, direction))
                }
                onRemove={() => remove("art", index)}
              />
            </div>
            <div className="world-editor-art-preview">
              <WorldImage
                asset={
                  draft.worldMedia[art.mediaId]?.id === art.mediaId
                    ? draft.worldMedia[art.mediaId]
                    : undefined
                }
                title={art.title}
                ownerId={draft.ownerId}
              />
            </div>
            <TextField
              label={`Artwork ${index + 1} title`}
              value={art.title}
              max={L.title}
              onChange={title =>
                change(
                  "art",
                  w.art.map((item, i) =>
                    i === index ? { ...item, title } : item
                  )
                )
              }
            />
            <LongField
              label={`Artwork ${index + 1} caption`}
              value={art.caption}
              max={L.caption}
              onChange={caption =>
                change(
                  "art",
                  w.art.map((item, i) =>
                    i === index ? { ...item, caption } : item
                  )
                )
              }
            />
          </div>
        ))}
        <WorldUpload
          slot="art"
          busy={busy}
          uploading={uploading === "art"}
          full={w.art.length >= WORLD_LIMITS.art}
          onUpload={onUpload}
        />
      </EditorSection>
      <EditorSection
        title="Little rooms in your world"
        detail="Up to six named panels for interests, your setup, commissions or schedule text. Plain text only; no HTML, CSS or scripts."
      >
        {w.panels.map((panel, index) => (
          <div className="world-edit-item" key={panel.id}>
            <div className="world-edit-item-head">
              <strong>Panel {index + 1}</strong>
              <OrderButtons
                label={`panel ${index + 1}`}
                index={index}
                length={w.panels.length}
                busy={busy}
                onMove={direction =>
                  change("panels", moveWorldItem(w.panels, index, direction))
                }
                onRemove={() =>
                  change(
                    "panels",
                    w.panels.filter((_, i) => i !== index)
                  )
                }
              />
            </div>
            <TextField
              label={`Panel ${index + 1} title`}
              value={panel.title}
              max={L.panelTitle}
              onChange={title =>
                change(
                  "panels",
                  w.panels.map((item, i) =>
                    i === index ? { ...item, title } : item
                  )
                )
              }
            />
            <LongField
              label={`Panel ${index + 1} text`}
              value={panel.text}
              max={L.panelText}
              onChange={text =>
                change(
                  "panels",
                  w.panels.map((item, i) =>
                    i === index ? { ...item, text } : item
                  )
                )
              }
            />
            <ColorField
              label={`Panel ${index + 1} accent`}
              value={panel.accentColor}
              onChange={accentColor =>
                change(
                  "panels",
                  w.panels.map((item, i) =>
                    i === index ? { ...item, accentColor } : item
                  )
                )
              }
            />
          </div>
        ))}
        <button
          type="button"
          className="profile-button"
          disabled={busy || w.panels.length >= WORLD_LIMITS.panels}
          onClick={() =>
            change("panels", [
              ...w.panels,
              {
                id: `panel_${crypto.randomUUID().replaceAll("-", "")}`,
                title: "New panel",
                text: "",
                accentColor: draft.theme.accentColor,
              },
            ])
          }
        >
          <Plus size={16} /> Add panel <span>{w.panels.length} / 6</span>
        </button>
      </EditorSection>
      <EditorSection
        title="Top people"
        detail="Choose up to eight actual visible member worlds. This is your selection, not a friends list or follower count."
      >
        <PeopleSelector
          ids={w.topPeople}
          busy={busy}
          onChange={ids => change("topPeople", ids)}
        />
      </EditorSection>
      <EditorSection
        title="Arrange the personal-page panels"
        detail="These five modules are independent of About, Games, Links, Posts and Clips. Hiding is appearance, not privacy."
      >
        <div className="profile-section-order">
          {w.moduleOrder.map((module, index) => (
            <div key={module}>
              <label>
                <input
                  type="checkbox"
                  checked={w.modules[module]}
                  onChange={event =>
                    change("modules", {
                      ...w.modules,
                      [module]: event.target.checked,
                    })
                  }
                />
                <span>{WORLD_SECTION_LABELS[module]}</span>
              </label>
              {([-1, 1] as const).map(direction => (
                <button
                  type="button"
                  key={direction}
                  className="profile-icon-button"
                  disabled={
                    busy ||
                    (direction === -1
                      ? index === 0
                      : index === w.moduleOrder.length - 1)
                  }
                  aria-label={`Move ${WORLD_SECTION_LABELS[module]} ${direction === -1 ? "up" : "down"}`}
                  onClick={() =>
                    change(
                      "moduleOrder",
                      moveWorldItem(w.moduleOrder, index, direction)
                    )
                  }
                >
                  {direction === -1 ? (
                    <ArrowUp size={16} />
                  ) : (
                    <ArrowDown size={16} />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </EditorSection>
    </div>
  );
}

function LongField({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <label className="profile-field">
      <span>
        {label}
        <small>
          {value.length} / {max}
        </small>
      </span>
      <textarea
        value={value}
        maxLength={max}
        rows={3}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  );
}
function OrderButtons({
  label,
  index,
  length,
  busy,
  onMove,
  onRemove,
}: {
  label: string;
  index: number;
  length: number;
  busy: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="world-item-actions">
      {([-1, 1] as const).map(direction => (
        <button
          type="button"
          key={direction}
          className="profile-icon-button"
          disabled={
            busy || (direction === -1 ? index === 0 : index === length - 1)
          }
          aria-label={`Move ${label} ${direction === -1 ? "up" : "down"}`}
          onClick={() => onMove(direction)}
        >
          {direction === -1 ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
        </button>
      ))}
      <button
        type="button"
        className="profile-icon-button"
        disabled={busy}
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}
function WorldUpload({
  slot,
  busy,
  uploading,
  full,
  onUpload,
}: {
  slot: WorldSlot;
  busy: boolean;
  uploading: boolean;
  full: boolean;
  onUpload: Upload;
}) {
  const [rights, setRights] = useState(false);
  const music = slot === "music";
  const disabled = busy || full || (music && !rights);
  return (
    <div className="world-upload">
      {music && (
        <label className="world-rights">
          <input
            type="checkbox"
            checked={rights}
            disabled={busy || full}
            onChange={event => setRights(event.target.checked)}
          />
          <span>
            I own this music or have permission to upload and share it with my
            selected audience. This acknowledgement is required for each upload.
          </span>
        </label>
      )}
      <label
        className={`profile-upload-label${disabled ? " world-upload-disabled" : ""}`}
      >
        {uploading ? (
          <Loader2 size={19} className="profile-spin" />
        ) : music ? (
          <Music2 size={19} />
        ) : (
          <ImagePlus size={19} />
        )}
        <span>
          {uploading
            ? "Processing private upload…"
            : full
              ? "Collection limit reached"
              : `Upload ${music ? "music" : "artwork"}`}
        </span>
        <input
          type="file"
          disabled={disabled}
          aria-label={`Upload ${music ? "owned or licensed music" : "gallery artwork"}`}
          accept={
            music
              ? ".mp3,.wav,.m4a,.ogg,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/ogg"
              : "image/jpeg,image/png,image/webp"
          }
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file || disabled) return;
            const acknowledged = rights;
            if (music) setRights(false);
            void onUpload(slot, file, acknowledged);
          }}
        />
      </label>
    </div>
  );
}
function PeopleSelector({
  ids,
  busy,
  onChange,
}: {
  ids: number[];
  busy: boolean;
  onChange: (ids: number[]) => void;
}) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const query = useData<Profile[]>(
    `/profiles${term ? `?search=${encodeURIComponent(term)}` : ""}`
  );
  const profiles = (query.error ? [] : query.data || []).filter(
    profile =>
      profile.saved &&
      profile.settings.discoverable &&
      canViewProfile(profile, user?.id) &&
      !ids.includes(profile.ownerId)
  );
  return (
    <>
      {ids.map((id, index) => (
        <div className="world-selected-person" key={id}>
          <SelectedPerson id={id} />
          <OrderButtons
            label={`selected person ${index + 1}`}
            index={index}
            length={ids.length}
            busy={busy}
            onMove={direction => onChange(moveWorldItem(ids, index, direction))}
            onRemove={() => onChange(ids.filter(value => value !== id))}
          />
        </div>
      ))}
      <label className="profile-field">
        <span>
          <Search size={15} /> Search real members{" "}
          <small>{ids.length} / 8 selected</small>
        </span>
        <input
          type="search"
          value={search}
          maxLength={100}
          placeholder="Display name, game, or headline"
          onChange={event => setSearch(event.target.value)}
        />
      </label>
      {query.isPending ? (
        <p className="profile-help" role="status">
          Loading member directory…
        </p>
      ) : query.error ? (
        <div className="profile-error" role="alert">
          <p>Member search couldn’t be loaded. {errorMessage(query.error)}</p>
          <button
            type="button"
            className="profile-button"
            disabled={busy || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </div>
      ) : profiles.length ? (
        <div className="world-people-results">
          {profiles.map(profile => (
            <button
              type="button"
              key={profile.ownerId}
              className="world-person-choice"
              disabled={busy || ids.length >= WORLD_LIMITS.people}
              onClick={() => onChange([...ids, profile.ownerId])}
            >
              <ProfileAvatar profile={profile} />
              <span>
                <strong>{profile.displayName}</strong>
                <small>{profile.headline || profile.roles.join(" / ")}</small>
              </span>
              <Plus size={16} aria-hidden="true" />
              <span className="profile-sr-only">
                Select {profile.displayName}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="profile-help">
          {term
            ? "No visible saved members match this search."
            : "No additional visible, discoverable saved profiles yet."}
        </p>
      )}
      <p className="profile-help">
        Unavailable or private people are omitted for visitors. Removing a
        person does not unfollow them. All selections stay local until Save.
      </p>
    </>
  );
}
function SelectedPerson({ id }: { id: number }) {
  const { user } = useAuth();
  const query = useData<Profile>(`/profiles/${id}`);
  const profile =
    !query.error && query.data?.saved && canViewProfile(query.data, user?.id)
      ? query.data
      : undefined;
  return (
    <div className="world-selected-identity">
      {profile && <ProfileAvatar profile={profile} />}
      <strong>
        {profile
          ? profile.displayName
          : query.isPending
            ? "Loading selected member…"
            : "Selected member unavailable"}
      </strong>
    </div>
  );
}
