import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Image,
  Music2,
  Quote,
  Users,
  X,
  ArrowUpRight,
  RefreshCw,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { api, useData } from "@/lib/app-api";
import { canViewProfile, type Profile } from "@shared/profile-types";
import type {
  ProfileWorld as World,
  WorldAsset,
  WorldMedia,
} from "@shared/profile-world-types";
import { ProfileAvatar } from "./MemberAvatar";
import { ProfileMusicPlayer } from "./ProfileMusicPlayer";
import {
  profileWorld,
  validWorldAsset,
  worldMediaUrl,
  WORLD_SECTION_LABELS,
} from "./world-utils";
import "./profile-world.css";

export function ProfileWorld({
  profile,
  preview = false,
}: {
  profile: Profile;
  preview?: boolean;
}) {
  const world = profileWorld(profile.world);
  const media = profile.worldMedia || {};
  return (
    <>
      {world.moduleOrder
        .filter(
          (module, index, order) =>
            order.indexOf(module) === index && world.modules[module]
        )
        .map(module => (
          <section
            key={module}
            className={`member-module member-panel member-world-module member-world-${module}`}
            style={{ order: 10 + world.moduleOrder.indexOf(module) }}
            aria-label={WORLD_SECTION_LABELS[module]}
          >
            <div className="member-module-heading">
              <span className="member-kicker">WORLD /</span>
              <h2>{WORLD_SECTION_LABELS[module]}</h2>
              {module === "quote" ? (
                <Quote size={18} />
              ) : module === "music" ? (
                <Music2 size={18} />
              ) : module === "art" ? (
                <Image size={18} />
              ) : module === "people" ? (
                <Users size={18} />
              ) : null}
            </div>
            {module === "quote" &&
              (world.quote ? (
                <blockquote className="world-quote">
                  <p>{world.quote}</p>
                  {world.quoteAuthor && <cite>— {world.quoteAuthor}</cite>}
                </blockquote>
              ) : (
                <p className="member-empty-copy">
                  No favorite quote added yet.
                </p>
              ))}
            {module === "music" && (
              <>
                {world.favoriteMusic.length > 0 && (
                  <div className="member-tags world-music-tags">
                    {world.favoriteMusic.map(tag => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                )}
                <ProfileMusicPlayer
                  tracks={world.music}
                  media={media}
                  ownerId={profile.ownerId}
                  preview={preview}
                />
                {!world.favoriteMusic.length && !world.music.length && (
                  <p className="member-empty-copy">
                    A soundtrack is personal. Add favorite-music tags or upload
                    music you have permission to share.
                  </p>
                )}
              </>
            )}
            {module === "art" && (
              <WorldGallery
                art={world.art}
                media={media}
                ownerId={profile.ownerId}
              />
            )}
            {module === "people" && (
              <FeaturedPeople
                ownerId={profile.ownerId}
                ids={world.topPeople}
                preview={preview}
              />
            )}
            {module === "panels" &&
              (world.panels.length ? (
                <div className="world-custom-panels">
                  {world.panels.map(panel => (
                    <section
                      className="world-custom-panel"
                      key={panel.id}
                      style={
                        {
                          "--panel-accent": /^#[0-9a-fA-F]{6}$/.test(
                            panel.accentColor
                          )
                            ? panel.accentColor
                            : "var(--member-accent)",
                        } as CSSProperties
                      }
                    >
                      <h3>{panel.title}</h3>
                      {panel.text ? (
                        <p>{panel.text}</p>
                      ) : (
                        <p className="member-empty-copy">No text added yet.</p>
                      )}
                    </section>
                  ))}
                </div>
              ) : (
                <p className="member-empty-copy">
                  No extra panels yet. This space can hold interests, a setup,
                  or a schedule in your own words.
                </p>
              ))}
          </section>
        ))}
    </>
  );
}

/** Auth-partitioned lookups are used for drafts; never render the owner's old saved selection in preview. */
function FeaturedPeople({
  ownerId,
  ids,
  preview,
}: {
  ownerId: number;
  ids: number[];
  preview: boolean;
}) {
  const { user, loading } = useAuth();
  const saved = useData<Profile[]>(`/profiles/${ownerId}/featured`, !preview);
  const draft = useQueries({
    queries: (preview ? ids : []).map(id => ({
      queryKey: ["app", user?.id ?? "anonymous", `/profiles/${id}`],
      queryFn: () => api<Profile>(`/profiles/${id}`),
      enabled: !loading,
      retry: false,
      refetchInterval: 10000,
    })),
  });
  const profiles = (
    preview
      ? draft.map(query => (query.error ? undefined : query.data))
      : saved.error
        ? []
        : saved.data || []
  ).filter((profile): profile is Profile =>
    Boolean(
      profile &&
        profile.saved &&
        ids.includes(profile.ownerId) &&
        canViewProfile(profile, user?.id)
    )
  );
  const ordered = ids.flatMap(id => {
    const profile = profiles.find(item => item.ownerId === id);
    return profile ? [profile] : [];
  });
  const pending = preview
    ? draft.some(query => query.isPending)
    : saved.isPending;
  const failed = preview
    ? draft.some(query => query.error)
    : Boolean(saved.error);
  if (!ids.length)
    return (
      <p className="member-empty-copy">
        No people featured yet. Only real, visible member worlds appear here.
      </p>
    );
  return (
    <>
      <p className="world-people-note">
        A personal selection, not a friends or follower count.
      </p>
      {ordered.length > 0 && (
        <div className="world-people-grid">
          {ordered.map(profile => (
            <Link
              className="world-person"
              key={profile.ownerId}
              href={`/u/${profile.ownerId}`}
            >
              <ProfileAvatar profile={profile} />
              <strong>{profile.displayName}</strong>
              <span>{profile.roles.join(" / ")}</span>
            </Link>
          ))}
        </div>
      )}
      {pending && (
        <p className="member-empty-copy" role="status">
          Loading visible member worlds…
        </p>
      )}
      {!pending && !ordered.length && (
        <p className="member-empty-copy">
          These selected worlds are not currently available to this viewer.
        </p>
      )}
      {failed && (
        <div className="world-inline-error" role="status">
          Some member worlds couldn’t be loaded or are no longer visible.
          <button
            type="button"
            className="profile-button"
            onClick={() => {
              if (preview) draft.forEach(query => void query.refetch());
              else void saved.refetch();
            }}
          >
            Try again
          </button>
        </div>
      )}
    </>
  );
}

export function WorldImage({
  asset,
  title,
  ownerId,
  eager = false,
}: {
  asset?: WorldAsset;
  title: string;
  ownerId: number;
  eager?: boolean;
}) {
  const { user } = useAuth();
  const [renewed, setRenewed] = useState<WorldAsset | undefined>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const attempted = useRef(false);
  const active = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const current = renewed || asset;
  const url =
    current && asset && current.id === asset.id && current.kind === "image"
      ? worldMediaUrl(current.id, current.url, window.location.origin)
      : null;
  useEffect(() => {
    active.current = true;
    attempted.current = false;
    setRenewed(undefined);
    setFailed(false);
    setLoading(false);
    return () => {
      active.current = false;
      abort.current?.abort();
    };
  }, [asset?.id, asset?.url, ownerId, user?.id]);
  async function refresh(manual = false) {
    if (!asset || loading || (!manual && attempted.current)) {
      if (active.current) setFailed(true);
      return;
    }
    attempted.current = true;
    setLoading(true);
    setFailed(true);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const next = await api<WorldAsset>(
        `/profile/world/media/${encodeURIComponent(asset.id)}`,
        { signal: controller.signal }
      );
      if (!active.current || controller.signal.aborted) return;
      if (
        next.id !== asset.id ||
        !validWorldAsset(next, "art", window.location.origin)
      )
        throw new Error("Artwork unavailable");
      setRenewed(next);
      setRevision(value => value + 1);
      setFailed(false);
    } catch {
      if (active.current && !controller.signal.aborted) setFailed(true);
    } finally {
      if (active.current && !controller.signal.aborted) setLoading(false);
    }
  }
  return (
    <div className="world-image">
      {url && !failed && (
        <img
          key={revision}
          src={url}
          alt={title}
          loading={eager ? "eager" : "lazy"}
          onError={() => void refresh()}
          onLoad={() => {
            attempted.current = false;
            setFailed(false);
          }}
        />
      )}
      {(!url || failed) && (
        <div className="world-image-missing">
          <Image size={24} aria-hidden="true" />
          <span>{loading ? "Refreshing artwork…" : "Artwork unavailable"}</span>
          {asset && (
            <button
              type="button"
              className="profile-button"
              disabled={loading}
              onClick={() => void refresh(true)}
            >
              <RefreshCw size={14} /> Retry artwork
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WorldGallery({
  art,
  media,
  ownerId,
}: {
  art: World["art"];
  media: WorldMedia;
  ownerId: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const item = art.find(artwork => artwork.mediaId === selected);
  useEffect(() => {
    const element = dialog.current;
    if (item && element && !element.open) {
      element.showModal();
      close.current?.focus();
    }
    if (!item && element?.open) element.close();
  }, [item]);
  useEffect(() => {
    setSelected(null);
  }, [ownerId]);
  if (!art.length)
    return (
      <p className="member-empty-copy">
        No artwork uploaded yet. This gallery contains only this member’s
        selected uploads.
      </p>
    );
  return (
    <>
      <div className="world-gallery">
        {art.map(artwork => (
          <figure key={artwork.mediaId}>
            <WorldImage
              asset={
                media[artwork.mediaId]?.id === artwork.mediaId
                  ? media[artwork.mediaId]
                  : undefined
              }
              title={artwork.title}
              ownerId={ownerId}
            />
            <figcaption>
              <strong>{artwork.title}</strong>
              {artwork.caption && <p>{artwork.caption}</p>}
              <button
                type="button"
                className="profile-button"
                onClick={() => setSelected(artwork.mediaId)}
              >
                View artwork <ArrowUpRight size={13} />
              </button>
            </figcaption>
          </figure>
        ))}
      </div>
      <dialog
        ref={dialog}
        className="world-art-dialog"
        aria-label={
          item ? `${item.title} · enlarged artwork` : "Enlarged artwork"
        }
        onClose={() => setSelected(null)}
        onClick={event => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {item && (
          <div className="world-art-dialog-body">
            <button
              ref={close}
              type="button"
              className="profile-button"
              onClick={() => dialog.current?.close()}
            >
              <X size={18} /> Close artwork
            </button>
            <WorldImage
              key={item.mediaId}
              asset={
                media[item.mediaId]?.id === item.mediaId
                  ? media[item.mediaId]
                  : undefined
              }
              title={item.title}
              ownerId={ownerId}
              eager
            />
            <h3>{item.title}</h3>
            {item.caption && <p>{item.caption}</p>}
          </div>
        )}
      </dialog>
    </>
  );
}
