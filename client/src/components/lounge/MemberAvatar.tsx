import { ImagePlus, Trash2 } from "lucide-react";
import type { ProfileSlot } from "./profile-utils";
import { useEffect, useRef, useState } from "react";
import { api, useData } from "@/lib/app-api";
import type { Profile, ProfileAsset } from "@shared/profile-types";
import { profileMediaUrl } from "./profile-utils";
import "./profile.css";

export function useProfileAssetUrl(asset?: ProfileAsset, poster = false) {
  const origin =
    typeof window === "undefined"
      ? "https://invalid.local"
      : window.location.origin;
  const candidate = asset
    ? profileMediaUrl(
        asset.id,
        poster ? asset.posterUrl : asset.url,
        origin,
        poster
      )
    : null;
  const identity = `${asset?.id ?? ""}:${poster}`;
  const [pinned, setPinned] = useState({
    identity,
    url: candidate,
    revision: 0,
  });
  const attempts = useRef(0),
    pending = useRef(false),
    active = useRef(true),
    current = useRef(identity);
  current.current = identity;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (pinned.identity !== identity) attempts.current = 0;
    setPinned(previous =>
      previous.identity === identity
        ? previous
        : { identity, url: candidate, revision: 0 }
    );
  }, [identity, candidate]);
  // Ticket refreshes must not restart a loaded image or video every ten seconds.
  const url = pinned.identity === identity ? pinned.url : candidate;
  async function recover() {
    if (!asset || pending.current) return;
    if (attempts.current >= 2) {
      setPinned(previous => ({ ...previous, identity, url: null }));
      return;
    }
    attempts.current++;
    pending.current = true;
    const requested = identity;
    try {
      // Unsaved draft uploads also need renewal; they are not returned by /profile/me yet.
      const refreshed = await api<ProfileAsset>(
        `/profile/media/${encodeURIComponent(asset.id)}`
      );
      const next =
        refreshed.id === asset.id
          ? profileMediaUrl(
              asset.id,
              poster ? refreshed.posterUrl : refreshed.url,
              origin,
              poster
            )
          : null;
      if (!next) throw new Error("Artwork is unavailable");
      if (active.current && current.current === requested)
        setPinned(previous => ({
          identity,
          url: next,
          revision: previous.revision + 1,
        }));
    } catch {
      if (active.current && current.current === requested)
        setPinned(previous => ({ ...previous, identity, url: null }));
    } finally {
      pending.current = false;
    }
  }
  return {
    url,
    recover,
    revision: pinned.revision,
    loaded: () => {
      attempts.current = 0;
    },
  };
}

export function ProfileMediaImage({
  asset,
  alt,
  className,
  poster = false,
  eager = false,
}: {
  asset: ProfileAsset;
  alt: string;
  className?: string;
  poster?: boolean;
  eager?: boolean;
}) {
  const { url, recover, revision, loaded } = useProfileAssetUrl(asset, poster);
  return url ? (
    <img
      key={`${asset.id}:${revision}`}
      className={className}
      src={url}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      referrerPolicy="same-origin"
      onError={recover}
      onLoad={loaded}
    />
  ) : (
    <span
      className={`member-image-unavailable ${className ?? ""}`}
      role="img"
      aria-label={`${alt}. Artwork unavailable.`}
    />
  );
}

export function ProfileAvatar({
  profile,
  className = "",
}: {
  profile: Profile;
  className?: string;
}) {
  const asset = profile.media.avatar;
  return (
    <span
      className={`member-avatar ${className}`}
      role="img"
      aria-label={`${profile.displayName}’s avatar`}
    >
      <span className="member-avatar-fallback" aria-hidden="true">
        {profile.avatarEmoji || initials(profile.displayName)}
      </span>
      {asset?.kind === "image" && profile.avatarMediaId === asset.id && (
        <ProfileMediaImage
          key={asset.id}
          asset={asset}
          alt=""
          className="member-avatar-image"
          eager
        />
      )}
    </span>
  );
}
function initials(name = "Member") {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part.slice(0, 1))
      .join("")
      .toLocaleUpperCase() || "M"
  );
}

export function MemberAvatar({
  userId,
  name,
  className = "",
}: {
  userId: number;
  name?: string;
  className?: string;
}) {
  const query = useData<Profile>(
    `/profiles/${userId}`,
    Number.isSafeInteger(userId) && userId > 0
  );
  if (query.data && !query.error)
    return <ProfileAvatar profile={query.data} className={className} />;
  return (
    <span
      className={`member-avatar ${className}`}
      role="img"
      aria-label={`${name || "Member"}’s avatar`}
    >
      <span className="member-avatar-fallback" aria-hidden="true">
        {initials(name)}
      </span>
    </span>
  );
}

export function ProfileMediaUpload({
  slot,
  profile,
  busy,
  uploading,
  onUpload,
  onRemove,
}: {
  slot: ProfileSlot;
  profile: Profile;
  busy: boolean;
  uploading: ProfileSlot | null;
  onUpload: (slot: ProfileSlot, file: File) => Promise<void>;
  onRemove: (slot: ProfileSlot) => void;
}) {
  const asset = profile.media[slot];
  return (
    <div className="profile-upload-field">
      {asset && (
        <div className={`profile-upload-preview profile-upload-${slot}`}>
          <ProfileMediaImage
            key={asset.id}
            asset={asset}
            poster={asset.kind === "video"}
            alt={`${slot} artwork preview`}
            eager
          />
          <span>
            {asset.width} × {asset.height}
            {asset.kind === "video"
              ? ` · silent video · ${Math.round(asset.duration || 0)}s`
              : " · image"}
          </span>
        </div>
      )}
      <label className="profile-upload-label">
        <ImagePlus size={18} />
        <span>
          {uploading === slot
            ? "Uploading & processing…"
            : `${asset ? "Replace" : "Upload"} ${slot}`}
        </span>
        <input
          type="file"
          aria-label={`${asset ? "Replace" : "Upload"} ${slot}`}
          disabled={busy}
          accept={`image/jpeg,image/png,image/webp${slot === "background" ? ",video/mp4,video/webm" : ""}`}
          onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void onUpload(slot, file);
          }}
        />
      </label>
      {uploading === slot && (
        <p className="profile-help" role="status">
          Uploading and sanitizing your file. The old artwork stays selected
          until this succeeds.
        </p>
      )}
      {profile[`${slot}MediaId`] && (
        <button
          type="button"
          className="profile-button"
          disabled={busy}
          onClick={() => onRemove(slot)}
        >
          <Trash2 size={14} />
          Remove {slot}
        </button>
      )}
      <p className="profile-help">
        Uploads stay owner-only until explicitly selected in a saved, visible
        profile.
      </p>
    </div>
  );
}
