import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Film,
  Gamepad2,
  Globe2,
  Link2,
  LockKeyhole,
  Palette,
  Pause,
  Play,
  Plus,
  Search,
  Shield,
  Sparkles,
  Users,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { errorMessage, seconds, useData } from "@/lib/app-api";
import { startLogin } from "@/const";
import {
  canViewProfile,
  PROFILE_ROLES,
  type Profile,
  type ProfileAsset,
  type ProfileModule,
} from "@shared/profile-types";
import type { Clip } from "@shared/app-types";
import {
  ProfileAvatar,
  ProfileMediaImage,
  useProfileAssetUrl,
} from "./MemberAvatar";
import { PostFeed } from "./Posts";
import { FollowControls } from "./SocialControls";
import { colorWithOpacity, safeSocialUrl, validHex } from "./profile-utils";
import "./profile.css";

export const PROFILE_SECTION_LABELS: Record<ProfileModule, string> = {
  about: "About me",
  games: "Games & platforms",
  links: "Find me elsewhere",
  posts: "Posts",
  clips: "Published clips",
};

export function ProfilePage({
  ownerId,
  onPost,
}: {
  ownerId?: number;
  onPost?: () => void;
}) {
  const { user, loading } = useAuth();
  const mine = ownerId === undefined || ownerId === user?.id;
  const validId =
    ownerId === undefined || (Number.isSafeInteger(ownerId) && ownerId > 0);
  const query = useData<Profile>(
    mine ? "/profile/me" : `/profiles/${ownerId}`,
    validId && (!mine || Boolean(user))
  );
  if (loading) return <ProfileState title="Loading your world…" />;
  if (mine && !user)
    return (
      <ProfileState
        title="Your own corner of the internet."
        detail="Sign in to create a personal world for your games, stories and people."
      >
        <button
          className="profile-button profile-primary"
          onClick={() => startLogin()}
        >
          Sign in to Respawn
        </button>
      </ProfileState>
    );
  if (!validId)
    return (
      <ProfileState
        title="This profile isn’t available."
        detail="Use a member’s profile link to open their world."
      />
    );
  if (query.isPending) return <ProfileState title="Loading this world…" />;
  if (query.error || !query.data || !canViewProfile(query.data, user?.id))
    return (
      <ProfileState
        title="This world isn’t available."
        detail="It may be private, not saved yet, or unavailable to this account."
      >
        <button
          className="profile-button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          Try again
        </button>
        <Link className="profile-button" href="/people">
          Find people
        </Link>
      </ProfileState>
    );
  const profile = query.data;
  return (
    <div className="profile-page">
      <div className="profile-page-bar">
        <Link href="/people">
          <ArrowLeft size={15} /> People
        </Link>
        <span>
          <Shield size={13} /> {mine ? "YOUR PERSONAL WORLD" : "MEMBER WORLD"}
        </span>
      </div>
      {mine && !profile.saved && (
        <div className="profile-notice">
          <Sparkles size={21} />
          <div>
            <strong>Your world is still a draft.</strong>
            <p>
              Customize it, choose who can visit, then explicitly save. You
              aren’t listed in People yet.
            </p>
          </div>
          <Link className="profile-button profile-primary" href="/profile/edit">
            Save your profile <ArrowUpRight size={15} />
          </Link>
        </div>
      )}
      <ProfileSurface
        key={`${user?.id ?? "anonymous"}:${profile.ownerId}`}
        profile={profile}
        own={mine}
        onPost={onPost}
      />
    </div>
  );
}

export function ProfileSurface({
  profile,
  own = false,
  preview = false,
  onPost,
}: {
  profile: Profile;
  own?: boolean;
  preview?: boolean;
  onPost?: () => void;
}) {
  const t = profile.theme;
  const color = (value: string, fallback: string) =>
    validHex(value) ? value : fallback;
  const style = {
    "--member-accent": color(t.accentColor, "#00e5ff"),
    "--member-secondary": color(t.secondaryColor, "#ff3da6"),
    "--member-text": color(t.textColor, "#f2f5ff"),
    "--member-card": colorWithOpacity(t.cardColor, t.cardOpacity),
    "--member-base": color(t.backgroundColor, "#090b14"),
    "--member-radius":
      t.corners === "square" ? "0px" : t.corners === "soft" ? "28px" : "14px",
    "--member-font":
      t.font === "mono"
        ? "ui-monospace, monospace"
        : t.font === "inter"
          ? "Inter, sans-serif"
          : "'Space Grotesk', sans-serif",
    "--member-shadow":
      t.glow === "none"
        ? "none"
        : `0 0 ${t.glow === "strong" ? "32px" : "14px"} ${colorWithOpacity(t.accentColor, t.glow === "strong" ? 0.25 : 0.1)}`,
  } as CSSProperties;
  const [share, setShare] = useState(false),
    [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  const sharePath = `/u/${profile.ownerId}`;
  const shareLink =
    typeof window === "undefined"
      ? sharePath
      : `${window.location.origin}${sharePath}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }
  return (
    <article
      className={`member-world member-layout-${t.layout}${preview ? " member-preview" : ""}`}
      style={style}
      aria-label={`${profile.displayName}’s ${preview ? "profile preview" : "profile"}`}
    >
      <ProfileBackdrop profile={profile} preview={preview} />
      <div className="member-world-content">
        <header className="member-hero member-panel">
          <div
            className={`member-banner${profile.media.banner && profile.bannerMediaId === profile.media.banner.id ? " member-banner-uploaded" : ""}`}
          >
            {profile.media.banner?.kind === "image" &&
              profile.bannerMediaId === profile.media.banner.id && (
                <ProfileMediaImage
                  key={profile.media.banner.id}
                  asset={profile.media.banner}
                  alt="Profile banner"
                  eager
                />
              )}
            <span className="member-banner-coordinate">
              {preview
                ? "LOCAL PREVIEW / NOT SAVED"
                : `PLAYER WORLD / ${String(profile.ownerId).padStart(4, "0")}`}
            </span>
            <span className="member-banner-symbol" aria-hidden="true">
              ✧
            </span>
          </div>
          <div className="member-hero-body">
            <div className="member-identity-row">
              <ProfileAvatar
                profile={profile}
                className="member-profile-avatar"
              />
              <div className="member-presence">
                <span aria-hidden="true">{profile.statusEmoji}</span>
                {profile.status || "In my own world"}
              </div>
            </div>
            <div className="member-hero-main">
              <div className="member-identity">
                <div className="member-role-list">
                  {profile.roles.map(role => (
                    <span key={role}>{role}</span>
                  ))}
                </div>
                <h1>{profile.displayName || "Your display name"}</h1>
                {profile.pronouns && (
                  <span className="member-pronouns">{profile.pronouns}</span>
                )}
                {profile.headline && (
                  <p className="member-headline">{profile.headline}</p>
                )}
              </div>
              {!preview && (
                <div className="member-hero-actions">
                  {own ? (
                    <>
                      <Link className="profile-button" href="/profile/edit">
                        <Palette size={16} />
                        {profile.saved ? "Customize profile" : "Save profile"}
                      </Link>
                      {onPost && (
                        <button
                          className="profile-button profile-primary"
                          onClick={onPost}
                        >
                          <Plus size={16} />
                          Write a post
                        </button>
                      )}
                    </>
                  ) : (
                    <FollowControls ownerId={profile.ownerId} />
                  )}
                  {profile.saved && (
                    <button
                      className="profile-button"
                      onClick={() => setShare(value => !value)}
                      aria-expanded={share}
                    >
                      <Link2 size={15} />
                      Share
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="member-world-meta">
              <span>
                {profile.settings.visibility === "private" ? (
                  <LockKeyhole size={13} />
                ) : profile.settings.visibility === "members" ? (
                  <Users size={13} />
                ) : (
                  <Globe2 size={13} />
                )}
                {profile.settings.visibility === "members"
                  ? "Members only"
                  : profile.settings.visibility === "private"
                    ? "Only you"
                    : "Public world"}
              </span>
              {preview && <span>Changes stay here until Save profile</span>}
              {!preview && own && profile.saved && (
                <FollowControls ownerId={profile.ownerId} />
              )}
            </div>
            {share && !preview && (
              <div className="member-share">
                <label>
                  Profile link
                  <input
                    readOnly
                    value={shareLink}
                    onFocus={event => event.currentTarget.select()}
                  />
                </label>
                <button className="profile-button" onClick={() => void copy()}>
                  {copied ? <Check size={15} /> : <Link2 size={15} />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <p role="status">
                  {copyError
                    ? "Select the link above to copy it manually. "
                    : ""}
                  Sharing never changes who can visit.
                </p>
              </div>
            )}
          </div>
        </header>
        <div className="member-module-grid">
          {t.moduleOrder
            .filter(
              (module, index, order) =>
                order.indexOf(module) === index && t.modules[module]
            )
            .map(module => (
              <section
                key={module}
                className={`member-module member-panel member-module-${module}`}
                aria-label={PROFILE_SECTION_LABELS[module]}
              >
                <div className="member-module-heading">
                  <span className="member-kicker">
                    {String(t.moduleOrder.indexOf(module) + 1).padStart(2, "0")}{" "}
                    /
                  </span>
                  <h2>{PROFILE_SECTION_LABELS[module]}</h2>
                  {module === "games" ? (
                    <Gamepad2 size={18} />
                  ) : module === "clips" ? (
                    <Film size={18} />
                  ) : null}
                </div>
                {module === "about" &&
                  (profile.bio ? (
                    <p className="member-bio">{profile.bio}</p>
                  ) : (
                    <p className="member-empty-copy">
                      {own || preview
                        ? "A few words about you belong here. Add your bio in the editor."
                        : "This member hasn’t added a bio yet."}
                    </p>
                  ))}
                {module === "games" && (
                  <>
                    <div className="member-tags">
                      {profile.games.map(game => (
                        <span key={game}>{game}</span>
                      ))}
                    </div>
                    {!profile.games.length && (
                      <p className="member-empty-copy">No games added yet.</p>
                    )}
                    {profile.platforms.length > 0 && (
                      <div className="member-platforms">
                        <span>PLAYING ON</span>
                        <div>
                          {profile.platforms.map(platform => (
                            <span key={platform}>{platform}</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
                {module === "links" && (
                  <div className="member-links">
                    {profile.links.map((link, index) => {
                      const href = safeSocialUrl(link.url);
                      return href ? (
                        <a
                          key={index}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer nofollow ugc"
                        >
                          <span>{link.label}</span>
                          <ArrowUpRight size={17} />
                        </a>
                      ) : null;
                    })}
                    {!profile.links.length && (
                      <p className="member-empty-copy">
                        No channels or social links added yet.
                      </p>
                    )}
                  </div>
                )}
                {module === "posts" && (
                  <PostFeed
                    ownerId={profile.ownerId}
                    compact
                    readOnly={preview}
                    title="Updates from this world"
                    onCreate={!preview && own ? onPost : undefined}
                  />
                )}
                {module === "clips" && (
                  <PublishedClips
                    ownerId={profile.ownerId}
                    own={!preview && own}
                  />
                )}
              </section>
            ))}
        </div>
        {!t.moduleOrder.some(module => t.modules[module]) && (
          <div className="member-panel member-no-sections">
            A quieter kind of world. All profile sections are hidden.
          </div>
        )}
        <footer className="member-world-footer">
          <span>
            respawn<span aria-hidden="true"> ↗</span>
          </span>
          <span>
            {preview
              ? "YOUR WORLD, YOUR WAY. PREVIEW ONLY."
              : "GOOD MOMENTS. REAL PEOPLE."}
          </span>
        </footer>
      </div>
    </article>
  );
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}
function ProfileBackdrop({
  profile,
  preview,
}: {
  profile: Profile;
  preview: boolean;
}) {
  const theme = profile.theme;
  const background =
    profile.media.background?.id === profile.backgroundMediaId
      ? profile.media.background
      : undefined;
  const ghost =
    profile.media.ghost?.id === profile.ghostMediaId
      ? profile.media.ghost
      : undefined;
  const { url: image } = useProfileAssetUrl(
    background?.kind === "image" ? background : undefined
  );
  const { url: ghostUrl } = useProfileAssetUrl(
    ghost?.kind === "image" ? ghost : undefined
  );
  const color = validHex(theme.backgroundColor)
    ? theme.backgroundColor
    : "#090b14";
  const color2 = validHex(theme.backgroundColor2)
    ? theme.backgroundColor2
    : "#211038";
  const imageStyle = {
    backgroundImage: image ? `url(${JSON.stringify(image)})` : undefined,
    backgroundRepeat: theme.backgroundSize === "tile" ? "repeat" : "no-repeat",
    backgroundSize:
      theme.backgroundSize === "tile" ? "240px auto" : theme.backgroundSize,
    backgroundPosition: theme.backgroundPosition,
  };
  return (
    <>
      <div className="member-backdrop" aria-hidden="true">
        <div
          className="member-backdrop-art"
          style={{
            opacity: theme.backgroundOpacity,
            filter: `blur(${theme.backgroundBlur}px)`,
            ...(theme.backgroundMode === "gradient"
              ? { background: `linear-gradient(135deg, ${color}, ${color2})` }
              : theme.backgroundMode === "image"
                ? imageStyle
                : { background: color }),
          }}
        >
          {theme.backgroundMode === "video" && background?.kind === "video" && (
            <BackgroundVideo
              key={background.id}
              asset={background}
              profile={profile}
              preview={preview}
              decorative
            />
          )}
        </div>
        <div
          className="member-backdrop-dim"
          style={{ background: `rgba(0,0,0,${theme.overlayOpacity})` }}
        />
        {ghostUrl && (
          <div
            className={`member-ghost member-ghost-${theme.ghostPosition} member-ghost-${theme.ghostSize}`}
            style={{
              backgroundImage: `url(${JSON.stringify(ghostUrl)})`,
              opacity: theme.ghostOpacity,
            }}
          />
        )}
      </div>
      {theme.backgroundMode === "video" && background?.kind === "video" && (
        <BackgroundControls key={background.id} />
      )}
    </>
  );
}
// Controls live outside the decorative layer, connected by context-free local DOM events.
function BackgroundControls() {
  const control = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    const world = control.current?.closest(".member-world");
    const update = (event: Event) => {
      const video = event.target as HTMLVideoElement;
      setPlaying(!video.paused);
      if (!video.paused) setFailed(false);
    };
    const failure = () => {
      setFailed(true);
      setPlaying(false);
    };
    const video = world?.querySelector("video");
    video?.addEventListener("play", update);
    video?.addEventListener("pause", update);
    video?.addEventListener("error", failure);
    return () => {
      video?.removeEventListener("play", update);
      video?.removeEventListener("pause", update);
      video?.removeEventListener("error", failure);
    };
  }, []);
  async function toggle() {
    const video = control.current
      ?.closest(".member-world")
      ?.querySelector("video");
    if (!video) return;
    if (!video.paused) video.pause();
    else {
      try {
        const src = video.dataset.source;
        if (!src) throw new Error();
        if (video.error || video.getAttribute("src") !== src) {
          video.src = src;
        }
        video.muted = true;
        await video.play();
        setFailed(false);
      } catch {
        setPlaying(false);
        setFailed(true);
      }
    }
  }
  return (
    <div className="member-motion-control">
      <button
        ref={control}
        className="profile-button"
        onClick={() => void toggle()}
        aria-pressed={playing}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
        {playing ? "Pause background" : "Play background"}
      </button>
      {failed && (
        <span role="status">
          Video unavailable or playback blocked. Poster shown.
        </span>
      )}
    </div>
  );
}
function BackgroundVideo({
  asset,
  profile,
  preview,
}: {
  asset: ProfileAsset;
  profile: Profile;
  preview: boolean;
  decorative?: boolean;
}) {
  const { url, recover, revision, loaded } = useProfileAssetUrl(asset);
  const { url: poster } = useProfileAssetUrl(asset, true);
  const video = useRef<HTMLVideoElement>(null);
  const osReduced = useReducedMotion();
  const autoplay =
    !preview &&
    profile.saved &&
    profile.settings.autoplayBackground &&
    !profile.settings.reducedMotion &&
    !osReduced;
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (!url) {
      element.pause();
      element.removeAttribute("src");
      element.load();
      return;
    }
    if (
      element.hasAttribute("src") &&
      (element.getAttribute("src") !== url || element.error)
    ) {
      element.src = url;
      element.load();
    }
    if (!autoplay) {
      element.pause();
      return;
    }
    if (url && !element.getAttribute("src")) element.src = url;
    element.muted = true;
    void element.play().catch(() => {
      /* Manual play stays available when the browser blocks autoplay. */
    });
  }, [autoplay, url, revision]);
  return (
    <video
      ref={video}
      className="member-background-video"
      data-source={url || undefined}
      poster={poster || undefined}
      muted
      playsInline
      loop
      preload="none"
      tabIndex={-1}
      style={{
        objectFit:
          profile.theme.backgroundSize === "contain" ? "contain" : "cover",
        objectPosition: profile.theme.backgroundPosition,
      }}
      onError={recover}
      onPlaying={loaded}
    />
  );
}

function PublishedClips({ ownerId, own }: { ownerId: number; own: boolean }) {
  const query = useData<Clip[]>("/clips?scope=feed");
  const clips = (query.data || []).filter(
    clip => clip.ownerId === ownerId && clip.published
  );
  if (query.isPending)
    return (
      <p className="member-empty-copy" role="status">
        Loading published clips…
      </p>
    );
  if (query.error)
    return (
      <div className="member-empty-copy" role="alert">
        <p>Published clips couldn’t be loaded.</p>
        <button
          className="profile-button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Try again
        </button>
      </div>
    );
  return clips.length ? (
    <div className="member-clips">
      {clips.map(clip => (
        <Link
          className="member-clip"
          key={clip.id}
          href={`/clip/${encodeURIComponent(clip.id)}`}
        >
          <div className="member-clip-poster">
            {safeClipPoster(clip) ? (
              <img src={safeClipPoster(clip)!} alt="" loading="lazy" />
            ) : (
              <Film size={29} />
            )}
            <span>{seconds(clip.end - clip.start)}</span>
          </div>
          <div>
            <small>{clip.game || "Published moment"}</small>
            <h3>{clip.title}</h3>
            <p>
              {clip.audience === "lounge"
                ? "Lounge audience · membership still applies"
                : "Public"}{" "}
              <ArrowUpRight size={14} />
            </p>
          </div>
        </Link>
      ))}
    </div>
  ) : (
    <div className="member-clips-empty">
      <Film size={27} />
      <h3>No published moments yet.</h3>
      <p>
        Only published clips appear here. The private Clip Tray stays private.
      </p>
      {own && (
        <Link className="profile-button" href="/tray">
          Open private Clip Tray <ArrowUpRight size={14} />
        </Link>
      )}
    </div>
  );
}
function safeClipPoster(clip: Clip) {
  try {
    if (!clip.posterUrl) return null;
    const origin =
      typeof window === "undefined"
        ? "https://invalid.local"
        : window.location.origin;
    const url = new URL(clip.posterUrl, origin);
    return url.origin === origin &&
      url.pathname === `/api/media/poster/clip/${encodeURIComponent(clip.id)}`
      ? `${url.pathname}${url.search}`
      : null;
  } catch {
    return null;
  }
}
export function ProfileState({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <section className="profile-state">
      <div className="profile-state-icon">
        <Gamepad2 size={30} />
      </div>
      <span className="profile-eyebrow">RESPAWN / PERSONAL WORLDS</span>
      <h1>{title}</h1>
      {detail && <p>{detail}</p>}
      <div className="profile-state-actions">{children}</div>
    </section>
  );
}

export function PeoplePage({ search = "" }: { search?: string }) {
  const [text, setText] = useState(search),
    [term, setTerm] = useState(search),
    [role, setRole] = useState("");
  const { user } = useAuth();
  useEffect(() => {
    setText(search);
    setTerm(search);
  }, [search]);
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(text.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [text]);
  const params = new URLSearchParams();
  if (term) params.set("search", term);
  if (role) params.set("role", role);
  const query = useData<Profile[]>(
    `/profiles${params.size ? `?${params}` : ""}`
  );
  const profiles = (query.data || []).filter(
    profile =>
      profile.saved &&
      profile.settings.discoverable &&
      profile.settings.visibility !== "private" &&
      canViewProfile(profile, user?.id)
  );
  return (
    <section className="profile-people">
      <header className="profile-people-heading">
        <span className="profile-eyebrow">FIND YOUR PEOPLE</span>
        <h1>
          Different games.
          <br />
          <span>Same wavelength.</span>
        </h1>
        <p>Meet the gamers, creators and streamers making Respawn their own.</p>
      </header>
      <form
        className="profile-people-filters"
        onSubmit={event => {
          event.preventDefault();
          setTerm(text.trim());
        }}
      >
        <label className="profile-search">
          <Search size={19} />
          <span className="profile-sr-only">Search members</span>
          <input
            type="search"
            value={text}
            maxLength={100}
            placeholder="Search real members…"
            onChange={event => setText(event.target.value)}
          />
        </label>
        <label className="profile-role-filter">
          <span>Role</span>
          <select value={role} onChange={event => setRole(event.target.value)}>
            <option value="">Everyone</option>
            {PROFILE_ROLES.map(value => (
              <option key={value} value={value}>
                {value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </form>
      <div className="profile-directory-heading">
        <h2>Member worlds</h2>
        <span>
          {query.isFetching
            ? "Refreshing…"
            : `${profiles.length} visible ${profiles.length === 1 ? "member" : "members"}`}
        </span>
      </div>
      {query.isPending ? (
        <ProfileState title="Finding your people…" />
      ) : query.error ? (
        <div className="profile-error" role="alert">
          <p>{errorMessage(query.error)}</p>
          <button
            className="profile-button"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </div>
      ) : profiles.length ? (
        <div className="profile-member-grid">
          {profiles.map(profile => (
            <article key={profile.ownerId} className="profile-member-card">
              <Link
                href={`/u/${profile.ownerId}`}
                className="profile-member-identity"
              >
                <ProfileAvatar profile={profile} />
                <div>
                  <div className="profile-member-roles">
                    {profile.roles.join(" / ")}
                  </div>
                  <h3>{profile.displayName}</h3>
                  {profile.headline && <p>{profile.headline}</p>}
                </div>
                <ArrowUpRight size={17} />
              </Link>
              {profile.games.length > 0 && (
                <div className="profile-member-games">
                  {profile.games.slice(0, 3).map(game => (
                    <span key={game}>{game}</span>
                  ))}
                </div>
              )}
              <footer>
                <Link href={`/u/${profile.ownerId}`}>
                  Visit world <ArrowUpRight size={14} />
                </Link>
                <FollowControls ownerId={profile.ownerId} />
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="profile-directory-empty">
          <Users size={34} />
          <h2>
            {term || role
              ? "No members match just yet."
              : "The next world could be yours."}
          </h2>
          <p>
            {term || role
              ? "Try another name or role. Only real, saved, discoverable profiles appear here."
              : "This directory starts with real people, not placeholders. Save a discoverable public or members-only profile to join it."}
          </p>
          {term || role ? (
            <button
              className="profile-button"
              onClick={() => {
                setText("");
                setTerm("");
                setRole("");
              }}
            >
              Clear filters
            </button>
          ) : (
            <Link
              className="profile-button profile-primary"
              href="/profile/edit"
            >
              Make your world <Palette size={15} />
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
