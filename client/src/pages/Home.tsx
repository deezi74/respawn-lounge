import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  ArrowUpRight,
  Bell,
  ChevronRight,
  Compass,
  Gamepad2,
  Layers,
  LayoutGrid,
  LockKeyhole,
  LogIn,
  LogOut,
  Menu,
  Plus,
  Radio,
  Search,
  Scissors,
  Settings2,
  Shield,
  Sparkles,
  Upload,
  Users,
  X,
  Play,
  Clock,
  Check,
  Filter,
  Film,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import {
  post,
  useData,
  useRefresh,
  seconds,
  errorMessage,
} from "@/lib/app-api";
import {
  defaultPreferences,
  type Source,
  type Clip,
  type Lounge,
  type Squad,
  type Preferences,
  type ServiceState,
} from "@shared/app-types";
import PlayerPage from "@/components/lounge/Player";
import ClipEditor from "@/components/lounge/ClipEditor";
import Sidekick, { type SidekickContext } from "@/components/lounge/Sidekick";
import { MemberSettings, Studio } from "@/components/lounge/SettingsStudio";
import Invite from "@/components/lounge/Invite";
import {
  Empty,
  Loading,
  ErrorPanel,
  UploadDialog,
  CreateDialog,
  Confirm,
} from "@/components/lounge/Controls";
const navigation = [
  { path: "/", label: "Discover", Icon: Compass },
  { path: "/lounges", label: "My Lounges", Icon: Users },
  { path: "/tray", label: "Clip Tray", Icon: Layers },
  { path: "/squads", label: "Find a Squad", Icon: Gamepad2 },
  { path: "/studio", label: "Creator Studio", Icon: Radio },
];
export default function Home() {
  const [path, navigate] = useLocation();
  const { user, loading: authLoading, logout } = useAuth();
  const [search, setSearch] = useState(""),
    [mobileMenu, setMobileMenu] = useState(false),
    [upload, setUpload] = useState(false),
    [create, setCreate] = useState<"lounge" | "squad" | null>(null),
    [editor, setEditor] = useState<Clip | null>(null),
    [sidekick, setSidekick] = useState<SidekickContext | null>(null);
  useEffect(() => {
    setEditor(null);
    setSidekick(null);
    setUpload(false);
    setCreate(null);
    if (user) {
      const invite = sessionStorage.getItem("respawn-pending-invite");
      if (invite && /^[a-zA-Z0-9-]{1,128}$/.test(invite)) {
        sessionStorage.removeItem("respawn-pending-invite");
        navigate(`/invite/${invite}`);
      }
    }
  }, [user?.id]);
  const sourceQ = useData<Source[]>("/sources");
  const feedQ = useData<Clip[]>("/clips?scope=feed");
  const trayQ = useData<Clip[]>("/clips?scope=tray", !!user);
  const loungeQ = useData<Lounge[]>("/lounges");
  const squadQ = useData<Squad[]>("/squads");
  const prefQ = useData<Preferences>("/settings", !!user);
  const services = useData<ServiceState>("/services");
  const [, watchParams] = useRoute("/watch/:id");
  const [, clipParams] = useRoute("/clip/:id");
  const [, inviteParams] = useRoute("/invite/:id");
  const prefs = prefQ.data || defaultPreferences;
  const mine =
    loungeQ.data?.filter(l => l.members.includes(user?.id || -1)) || [];
  function requireUser(action: () => void) {
    if (user) action();
    else {
      toast.info("Sign in to make this space yours.");
      startLogin();
    }
  }
  const openSidekick = (context: SidekickContext) =>
    requireUser(() => setSidekick(context));
  const openUpload = () => requireUser(() => setUpload(true));
  const protectedPage = ["/tray", "/studio", "/settings", "/profile"].includes(
    path
  );
  const title =
    path === "/tray"
      ? "Clip Tray"
      : path === "/squads"
        ? "Find a Squad"
        : path === "/lounges"
          ? "My Lounges"
          : path === "/studio"
            ? "Creator Studio"
            : path === "/settings"
              ? "Settings"
              : path === "/profile"
                ? "My Profile"
                : "Discover";
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "mobile-open" : ""}`}>
        <Link href="/" className="brand">
          <img src="/brand/logo.svg" alt="Respawn mark" />
          <div>
            <span>
              respawn<span className="brand-dot">.</span>
            </span>
            <small>LOUNGE</small>
          </div>
        </Link>
        <div className="nav-heading">YOUR NEXT RESPAWN</div>
        <nav>
          {navigation.map(({ path: p, label, Icon }) => (
            <Link
              key={p}
              href={p}
              onClick={() => setMobileMenu(false)}
              className={`nav-item ${path === p ? "active" : ""}`}
            >
              <Icon size={19} />
              {label}
              {p === "/tray" && !!trayQ.data?.length && (
                <span className="nav-count">{trayQ.data.length}</span>
              )}
              {p === "/studio" && (
                <ArrowUpRight className="nav-arrow" size={14} />
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-heading sidebar-lounge-heading">
          YOUR LOUNGES
          <button
            className="icon-btn"
            aria-label="Create Lounge"
            onClick={() => requireUser(() => setCreate("lounge"))}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="sidebar-lounges">
          {mine.length ? (
            mine.slice(0, 4).map((l, i) => (
              <Link href="/lounges" key={l.id}>
                <span className={`lounge-dot dot-${i}`}>{l.name[0]}</span>
                <span>{l.name}</span>
                {l.privacy === "private" && <LockKeyhole size={12} />}
              </Link>
            ))
          ) : (
            <p>
              Your people belong here.
              <br />
              <button
                className="text-btn"
                onClick={() => requireUser(() => setCreate("lounge"))}
              >
                Create your first Lounge
                <ChevronRight size={12} />
              </button>
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="sidebar-sidekick">
            <div>
              <Sparkles size={22} />
              <span>Meet your Sidekick</span>
            </div>
            <p>
              A little AI backup.
              <br />A lot more time to play.
            </p>
            <button onClick={() => openSidekick({})}>
              Say hello
              <ArrowUpRight size={14} />
            </button>
          </div>
          <Link
            className={`nav-item ${path === "/settings" ? "active" : ""}`}
            href="/settings"
          >
            <Settings2 size={18} />
            Settings
          </Link>
          <div className="sidebar-profile">
            {user ? (
              <>
                <Link href="/profile" className="avatar">
                  {user.name?.[0]?.toUpperCase() || "G"}
                </Link>
                <Link href="/profile">
                  <strong>{user.name || "Gamer"}</strong>
                  <small>Make yourself at home</small>
                </Link>
                <button
                  className="icon-btn"
                  aria-label="Sign out"
                  onClick={() => logout()}
                >
                  <LogOut size={15} />
                </button>
              </>
            ) : (
              <button className="btn sign-in" onClick={startLogin}>
                <LogIn size={17} />
                Sign in to Respawn
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobileMenu(!mobileMenu)}
            >
              <Menu size={21} />
            </button>
            <span>THE LOUNGE</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            <label className="search">
              <Search size={16} />
              <input
                aria-label="Search streams, clips and games"
                placeholder="Search games, moments, people…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <kbd>/</kbd>
            </label>
            <button className="btn small upload-top" onClick={openUpload}>
              <Plus size={16} />
              Create
            </button>
            {user ? (
              <Link href="/profile" className="avatar small-avatar">
                {user.name?.[0]?.toUpperCase() || "G"}
              </Link>
            ) : (
              <button className="text-btn" onClick={startLogin}>
                Sign in
                <ArrowUpRight size={15} />
              </button>
            )}
          </div>
        </header>
        <main className="main-content">
          {protectedPage && !user ? (
            authLoading ? (
              <Loading />
            ) : (
              <div className="signin-state">
                <div className="eyebrow">THIS PART IS YOURS</div>
                <h1>
                  A space for your
                  <br />
                  best moments.
                </h1>
                <p>
                  Sign in to save clips, build your Lounge, and meet your
                  personal Gaming Sidekick.
                </p>
                <button className="btn primary" onClick={startLogin}>
                  <LogIn size={18} />
                  Sign in with Manus
                </button>
                <small>
                  Real accounts. Your clips stay private until you share.
                </small>
              </div>
            )
          ) : inviteParams ? (
            <Invite id={inviteParams.id} />
          ) : watchParams ? (
            <PlayerPage
              id={watchParams.id}
              onSidekick={openSidekick}
              onEdit={setEditor}
            />
          ) : clipParams ? (
            <PlayerPage
              id={clipParams.id}
              isClip
              onSidekick={openSidekick}
              onEdit={setEditor}
            />
          ) : path === "/settings" ? (
            <MemberSettings />
          ) : path === "/studio" ? (
            <Studio onUpload={openUpload} />
          ) : path === "/tray" || path === "/profile" ? (
            <Tray
              clips={trayQ.data || []}
              loading={trayQ.isLoading}
              error={trayQ.error}
              onEdit={setEditor}
              onSidekick={openSidekick}
              search={search}
              profile={path === "/profile"}
              duration={prefs.clipDuration}
            />
          ) : path === "/lounges" ? (
            <Lounges
              lounges={loungeQ.data || []}
              loading={loungeQ.isLoading}
              error={loungeQ.error}
              userId={user?.id}
              onCreate={() => requireUser(() => setCreate("lounge"))}
              search={search}
            />
          ) : path === "/squads" ? (
            <Squads
              squads={squadQ.data || []}
              loading={squadQ.isLoading}
              error={squadQ.error}
              userId={user?.id}
              onCreate={() => requireUser(() => setCreate("squad"))}
              onSidekick={() => openSidekick({})}
              search={search}
            />
          ) : (
            <Discover
              sources={sourceQ.data || []}
              clips={feedQ.data || []}
              loading={sourceQ.isLoading}
              error={sourceQ.error}
              onUpload={openUpload}
              onSidekick={() => openSidekick({})}
              search={search}
            />
          )}
        </main>
        <footer className="app-footer">
          <span>GOOD GAMES. BETTER COMPANY.</span>
          <span>
            <i className={services.data?.processing ? "status-live" : ""} />{" "}
            Media {services.data?.processing ? "ready" : "checking"}
            <span className="footer-separator">/</span> Live not connected
          </span>
        </footer>
      </div>
      <nav className="mobile-nav">
        {navigation.slice(0, 4).map(({ path: p, label, Icon }) => (
          <Link className={path === p ? "active" : ""} href={p} key={p}>
            <Icon size={21} />
            <span>
              {p === "/"
                ? "Discover"
                : p === "/lounges"
                  ? "Lounges"
                  : p === "/tray"
                    ? "Clips"
                    : "Squads"}
            </span>
          </Link>
        ))}
        <button onClick={() => openSidekick({})}>
          <Sparkles size={21} />
          <span>Sidekick</span>
        </button>
      </nav>
      {sidekick && (
        <Sidekick
          context={sidekick}
          onClose={() => setSidekick(null)}
          onEdit={c => {
            setEditor(c);
            setSidekick(null);
          }}
        />
      )}
      {editor && (
        <ClipEditor
          key={`${editor.id}-${editor.crop}-${editor.captions.length}`}
          clip={editor}
          onClose={() => setEditor(null)}
          onSidekick={openSidekick}
        />
      )}{" "}
      {upload && (
        <UploadDialog
          lounges={mine}
          onClose={() => setUpload(false)}
          onUploaded={() => {}}
        />
      )}
      {create && <CreateDialog kind={create} onClose={() => setCreate(null)} />}
    </div>
  );
}
function Discover({
  sources,
  clips,
  loading,
  error,
  onUpload,
  onSidekick,
  search,
}: {
  sources: Source[];
  clips: Clip[];
  loading: boolean;
  error: unknown;
  onUpload: () => void;
  onSidekick: () => void;
  search: string;
}) {
  const [filter, setFilter] = useState("For you");
  const games = [...new Set(sources.map(s => s.game))];
  const filtered = sources.filter(
    s =>
      (filter === "For you" ||
        (filter === "Live now" && s.status === "live") ||
        s.game === filter) &&
      `${s.title} ${s.game} ${s.creatorName}`
        .toLowerCase()
        .includes(search.toLowerCase())
  );
  return (
    <>
      <div className="page-heading row">
        <div>
          <span className="eyebrow">
            <span className="little-spark" />
            YOUR PEOPLE. YOUR PLAYS.
          </span>
          <h1>
            Good games start here<span className="lime-text">.</span>
          </h1>
          <p>Catch the action. Keep the moments. Find your crew.</p>
        </div>
        <Link href="/squads" className="btn">
          <Users size={17} />
          Find your squad
          <ArrowUpRight size={16} />
        </Link>
      </div>
      <div className="discover-feature">
        <div className="feature-copy">
          <span className="feature-badge">
            <Scissors size={14} />A NEW WAY TO KEEP THE GOOD STUFF
          </span>
          <h2>
            Some moments
            <br />
            deserve a <span>respawn.</span>
          </h2>
          <p>
            One tap to clip it. Your Sidekick to make it yours.
            <br />
            Your Lounge to share it with.
          </p>
          <div>
            <button className="btn primary" onClick={onUpload}>
              <Upload size={17} />
              Share your gameplay
              <ArrowUpRight size={16} />
            </button>
            <button className="feature-sidekick-link" onClick={onSidekick}>
              Meet your Sidekick
              <Sparkles size={16} />
            </button>
          </div>
          <div className="feature-proof">
            <Shield size={14} />
            Private first. Creator credited. Always your call.
          </div>
        </div>
        <div className="feature-art">
          <img src="/brand/valorant.jpg" alt="VALORANT gameplay environment" />
          <div className="art-grid" />
          <div className="art-clip">
            <Scissors size={19} />
            <div>
              <strong>Clip That</strong>
              <span>Your moment, saved.</span>
            </div>
            <kbd>C</kbd>
          </div>
          <div className="art-sidekick">
            <Sparkles size={18} />
            <span>A little backup. A better clip.</span>
          </div>
          <div className="art-corner">PLAY / CLIP / RESPAWN</div>
        </div>
      </div>
      <div className="discovery-tabs">
        <div>
          {["For you", "Live now", ...games.slice(0, 4)].map(f => (
            <button
              className={filter === f ? "selected" : ""}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f === "Live now" && <span className="live-dot" />}
              {f}
            </button>
          ))}
        </div>
        <span className="tiny">CURATED BY YOUR COMMUNITY</span>
      </div>
      <div className="section-head">
        <div>
          <h2>
            {filter === "Live now" ? "Live in the Lounge" : "Worth a watch"}
          </h2>
          <p>From your community. Made for your next break.</p>
        </div>
        <span className="section-count">
          {filtered.length} {filtered.length === 1 ? "video" : "videos"}
        </span>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorPanel error={error} />
      ) : filtered.length ? (
        <div className="media-grid">
          {filtered.map(s => (
            <SourceCard source={s} key={s.id} />
          ))}
        </div>
      ) : (
        <Empty
          title={
            filter === "Live now"
              ? "Live streaming isn’t connected yet"
              : search
                ? "No matches just yet"
                : "Be the first to press play"
          }
          description={
            filter === "Live now"
              ? "Live broadcasting is disabled for now. You can still upload, watch and clip real videos."
              : search
                ? "Try a different title or game."
                : "This is a new Lounge. Upload your gameplay and give your community something worth a replay."
          }
          action={filter === "Live now" ? undefined : "Upload a video"}
          onAction={onUpload}
        />
      )}
      <div className="lower-discover">
        <section>
          <div className="section-head">
            <div>
              <h2>Small clips. Big moments.</h2>
              <p>The plays your people kept.</p>
            </div>
            <Link href="/tray" className="text-btn">
              Your Clip Tray
              <ArrowUpRight size={15} />
            </Link>
          </div>
          {clips.length ? (
            <div className="clip-feed">
              {clips.slice(0, 3).map(c => (
                <ClipCard clip={c} key={c.id} />
              ))}
            </div>
          ) : (
            <div className="community-empty">
              <Layers size={24} />
              <div>
                <strong>The highlight reel is waiting.</strong>
                <p>
                  Published clips will appear here. Capture a real moment to
                  start it.
                </p>
              </div>
              <ArrowUpRight size={19} />
            </div>
          )}
        </section>
        <aside className="squad-promo">
          <div>
            <span className="eyebrow">DON’T SOLO THE WHOLE NIGHT</span>
            <Gamepad2 size={23} />
          </div>
          <h3>
            Better with
            <br />
            your kind of people.
          </h3>
          <p>Find an open squad. Same game, same vibe.</p>
          <Link href="/squads" className="text-btn">
            Find a squad
            <ArrowUpRight size={16} />
          </Link>
        </aside>
      </div>
    </>
  );
}
function SourceCard({ source: s }: { source: Source }) {
  return (
    <Link href={`/watch/${s.id}`} className="media-card">
      <div className="media-thumbnail">
        {s.posterUrl ? (
          <img src={s.posterUrl} alt={s.title} />
        ) : (
          <div className="media-placeholder">
            <Film size={29} />
            <span>{s.status}</span>
          </div>
        )}
        <div className="thumbnail-top">
          {s.status === "live" && <span className="live-badge">LIVE</span>}
          {s.audience === "lounge" && (
            <span className="private-badge">
              <LockKeyhole size={12} />
              Lounge
            </span>
          )}
        </div>
        <span className="duration-badge">{seconds(s.duration)}</span>
        <div className="hover-play">
          <Play size={23} fill="currentColor" />
        </div>
      </div>
      <div className="media-card-content">
        <div className="avatar">{s.creatorName?.[0] || "R"}</div>
        <div>
          <h3>{s.title}</h3>
          <p>
            {s.creatorName}
            <span className="verified">
              <Check size={10} />
            </span>
          </p>
          <small>
            {s.game} · {s.kind === "upload" ? "Uploaded video" : "Replay"}
          </small>
        </div>
      </div>
    </Link>
  );
}
function ClipCard({
  clip: c,
  onEdit,
}: {
  clip: Clip;
  onEdit?: (c: Clip) => void;
}) {
  return (
    <div className="clip-card">
      <Link href={`/clip/${c.id}`} className="clip-image">
        {c.posterUrl ? (
          <img src={c.posterUrl} alt={c.title} />
        ) : (
          <div className="media-placeholder">
            <Scissors size={26} />
          </div>
        )}
        <span className="duration-badge">{seconds(c.end - c.start)}</span>
        <span className={`clip-state ${c.status}`}>
          {c.status === "bookmarked" ? "Moment bookmarked" : c.status}
        </span>
      </Link>
      <div className="clip-card-body">
        <span className="eyebrow">{c.game}</span>
        <h3>
          <Link href={`/clip/${c.id}`}>{c.title}</Link>
        </h3>
        <p>Original by {c.creatorName}</p>
        <div>
          <span>
            <Shield size={12} />
            {c.published ? "Published" : "Private draft"}
          </span>
          {onEdit && (
            <button className="text-btn" onClick={() => onEdit(c)}>
              Edit
              <ArrowUpRight size={14} />
            </button>
          )}
        </div>
        {c.error && <p className="error-copy">{c.error}</p>}
      </div>
    </div>
  );
}
function Tray({
  clips,
  loading,
  error,
  onEdit,
  onSidekick,
  search,
  profile,
  duration,
}: {
  clips: Clip[];
  loading: boolean;
  error: unknown;
  onEdit: (c: Clip) => void;
  onSidekick: (c: SidekickContext) => void;
  search: string;
  profile?: boolean;
  duration: number;
}) {
  const [filter, setFilter] = useState("All moments");
  const filtered = clips.filter(
    c =>
      (filter === "All moments" ||
        (filter === "Private drafts" && !c.published) ||
        (filter === "Published" && c.published)) &&
      `${c.title} ${c.game}`.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <>
      <div className="page-heading row">
        <div>
          <span className="eyebrow">YOUR PERSONAL HIGHLIGHT REEL</span>
          <h1>
            {profile ? "Your plays. Your people." : "Keep the good stuff."}
          </h1>
          <p>Saved in one tap. Private until you say otherwise.</p>
        </div>
        <button className="btn sidekick-btn" onClick={() => onSidekick({})}>
          <Sparkles size={17} />
          Ask your Sidekick
        </button>
      </div>
      <div className="tray-summary">
        <div>
          <Scissors size={22} />
          <strong>{clips.length}</strong>
          <span>saved moments</span>
        </div>
        <div>
          <Shield size={22} />
          <strong>{clips.filter(c => !c.published).length}</strong>
          <span>private drafts</span>
        </div>
        <div>
          <Clock size={22} />
          <strong>{duration}s</strong>
          <span>
            one-tap default<Link href="/settings">Change</Link>
          </span>
        </div>
      </div>
      <div className="discovery-tabs">
        <div>
          {["All moments", "Private drafts", "Published"].map(f => (
            <button
              className={filter === f ? "selected" : ""}
              onClick={() => setFilter(f)}
              key={f}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="tiny">ORIGINAL CREATORS ALWAYS CREDITED</span>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorPanel error={error} />
      ) : filtered.length ? (
        <div className="tray-grid">
          {filtered.map(c => (
            <ClipCard clip={c} key={c.id} onEdit={onEdit} />
          ))}
        </div>
      ) : (
        <Empty
          title="Your best moments are still ahead"
          description="Open a video and tap Clip That. Your previous available seconds land here while playback keeps going."
        />
      )}
      <div className="tray-helper">
        <span>
          01 <Scissors size={17} />
          Clip a moment
        </span>
        <ChevronRight size={14} />
        <span>
          02 <Sparkles size={17} />
          Make it yours
        </span>
        <ChevronRight size={14} />
        <span>
          03 <Users size={17} />
          Share with your people
        </span>
      </div>
    </>
  );
}
function Lounges({
  lounges,
  loading,
  error,
  userId,
  onCreate,
  search,
}: {
  lounges: Lounge[];
  loading: boolean;
  error: unknown;
  userId?: number;
  onCreate: () => void;
  search: string;
}) {
  const refresh = useRefresh();
  const [confirm, setConfirm] = useState<{ l: Lounge; uid?: number } | null>(
    null
  );
  return (
    <>
      <div className="page-heading row">
        <div>
          <span className="eyebrow">A PLACE FOR YOUR PEOPLE</span>
          <h1>Find your corner.</h1>
          <p>Shared games. Inside jokes. Moments that stay with the crew.</p>
        </div>
        <button className="btn primary" onClick={onCreate}>
          <Plus size={17} />
          Create a Lounge
        </button>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorPanel error={error} />
      ) : lounges.length ? (
        <div className="lounge-grid">
          {lounges
            .filter(l =>
              `${l.name} ${l.game}`.toLowerCase().includes(search.toLowerCase())
            )
            .map((l, i) => (
              <section className="lounge-card" key={l.id}>
                <div className={`lounge-card-cover cover-${i % 3}`}>
                  <div className="lounge-big-mark">
                    {l.name.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="audience-pill">
                    <Shield size={12} />
                    {l.privacy}
                  </span>
                </div>
                <div className="lounge-card-body">
                  <span className="eyebrow">{l.game}</span>
                  <h2>{l.name}</h2>
                  <p>
                    {l.description || "A place for your next shared moment."}
                  </p>
                  <div className="lounge-card-footer">
                    <span>
                      <Users size={15} />
                      {l.members.length}{" "}
                      {l.members.length === 1 ? "member" : "members"}
                    </span>
                    {l.members.includes(userId || -1) ? (
                      <span className="member-badge">
                        <Check size={14} />
                        Member
                      </span>
                    ) : (
                      <button
                        className="btn small"
                        disabled={l.requests?.some(r => r.userId === userId)}
                        onClick={() => {
                          if (!userId) startLogin();
                          else setConfirm({ l });
                        }}
                      >
                        {l.requests?.some(r => r.userId === userId)
                          ? "Requested"
                          : "Join request"}
                        <ArrowUpRight size={14} />
                      </button>
                    )}
                  </div>
                  {l.ownerId === userId && (
                    <button
                      className="btn small lounge-invite-copy"
                      onClick={async () => {
                        const link = `${window.location.origin}/invite/${l.id}`;
                        try {
                          await navigator.clipboard.writeText(link);
                          toast.success(
                            "Invitation copied. Membership approval is still required."
                          );
                        } catch {
                          toast.info(`Invite link: ${link}`, {
                            duration: 15000,
                          });
                        }
                      }}
                    >
                      <Users size={14} />
                      Copy invite link
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                  {l.ownerId === userId && !!l.requests?.length && (
                    <div className="join-requests">
                      <h4>Membership requests</h4>
                      {l.requests.map(r => (
                        <div key={r.userId}>
                          <span>{r.name}</span>
                          <button
                            className="btn small"
                            onClick={() => setConfirm({ l, uid: r.userId })}
                          >
                            Approve
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {l.members.includes(userId || -1) && <LoungeFeed id={l.id} />}
                </div>
              </section>
            ))}
        </div>
      ) : (
        <Empty
          icon="users"
          title="Make a Lounge of your own"
          description="Create a private space for your crew or a public one for your game. Members and clips are real—no filler."
          action="Create your first Lounge"
          onAction={onCreate}
        />
      )}
      {confirm && (
        <Confirm
          title={confirm.uid ? "Approve membership?" : "Send a join request?"}
          description={
            confirm.uid
              ? `Add this member to ${confirm.l.name}? They will be able to access its private content.`
              : `Ask to join ${confirm.l.name}. The owner will review your request.`
          }
          label={confirm.uid ? "Approve member" : "Send request"}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await post(
              `/lounges/${confirm.l.id}/${confirm.uid ? "approve" : "join"}`,
              { userId: confirm.uid, confirmed: true }
            );
            await refresh();
            toast.success(
              confirm.uid ? "Member approved." : "Join request sent."
            );
          }}
        />
      )}
    </>
  );
}
function LoungeFeed({ id }: { id: string }) {
  const clips = useData<Clip[]>(`/clips?scope=feed&loungeId=${id}`);
  return (
    <div className="lounge-feed-preview">
      <span className="tiny">LOUNGE MOMENTS</span>
      {clips.data?.length ? (
        clips.data.slice(0, 3).map(c => (
          <Link key={c.id} href={`/clip/${c.id}`}>
            <Play size={13} />
            {c.title}
            <ArrowUpRight size={13} />
          </Link>
        ))
      ) : (
        <p>No published moments yet. Clip a video and share it here.</p>
      )}
    </div>
  );
}
function Squads({
  squads,
  loading,
  error,
  userId,
  onCreate,
  onSidekick,
  search,
}: {
  squads: Squad[];
  loading: boolean;
  error: unknown;
  userId?: number;
  onCreate: () => void;
  onSidekick: () => void;
  search: string;
}) {
  const [platform, setPlatform] = useState("All platforms"),
    [confirm, setConfirm] = useState<{ s: Squad; uid?: number } | null>(null);
  const refresh = useRefresh();
  const list = squads.filter(
    s =>
      (platform === "All platforms" || s.platform === platform) &&
      `${s.title} ${s.game}`.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <>
      <div className="page-heading row">
        <div>
          <span className="eyebrow">SAME GAME. SAME VIBE.</span>
          <h1>Don’t solo the whole night.</h1>
          <p>Real squads. Open spots. Your kind of company.</p>
        </div>
        <button className="btn primary" onClick={onCreate}>
          <Plus size={17} />
          Open a squad
        </button>
      </div>
      <div className="squad-assist">
        <Sparkles size={26} />
        <div>
          <strong>Let your Sidekick find the fit.</strong>
          <p>Your selected games, platform, mic preference and availability.</p>
        </div>
        <button className="btn" onClick={onSidekick}>
          Find me a chill squad
          <ArrowUpRight size={16} />
        </button>
      </div>
      <div className="squad-filters">
        <h2>
          Open squads<span>{list.length}</span>
        </h2>
        <select
          aria-label="Filter squad platform"
          value={platform}
          onChange={e => setPlatform(e.target.value)}
        >
          {[
            "All platforms",
            "PC",
            "PlayStation",
            "Xbox",
            "Nintendo Switch",
            "Mobile",
            "Cross-play",
          ].map(v => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorPanel error={error} />
      ) : list.length ? (
        <div className="squad-list">
          {list.map(s => (
            <section key={s.id} className="squad-card">
              <div className="squad-game-icon">
                <Gamepad2 size={28} />
              </div>
              <div className="squad-info">
                <div>
                  <span className="eyebrow">{s.game}</span>
                  <span className="vibe-tag">{s.vibe}</span>
                </div>
                <h3>{s.title}</h3>
                <p>
                  {s.platform} ·{" "}
                  {s.mic === "required"
                    ? "Mic required"
                    : s.mic === "no-mic"
                      ? "No mic"
                      : "Mic optional"}{" "}
                  ·{" "}
                  {new Date(s.startsAt).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
                <small>
                  Hosted by {s.ownerName} · expires{" "}
                  {new Date(s.expiresAt).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </small>
                {s.ownerId === userId &&
                  s.requests?.map(r => (
                    <div key={r.userId} className="squad-request">
                      {r.name} wants to join
                      <button
                        className="btn small"
                        onClick={() => setConfirm({ s, uid: r.userId })}
                      >
                        Approve
                      </button>
                    </div>
                  ))}
              </div>
              <div className="squad-join">
                <span>
                  <Users size={15} />
                  {s.members.length}/{s.capacity} players
                </span>
                <button
                  className="btn primary small"
                  disabled={
                    s.members.includes(userId || -1) ||
                    s.requests?.some(r => r.userId === userId) ||
                    s.members.length >= s.capacity
                  }
                  onClick={() => (userId ? setConfirm({ s }) : startLogin())}
                >
                  {s.members.includes(userId || -1)
                    ? "In your squad"
                    : s.requests?.some(r => r.userId === userId)
                      ? "Requested"
                      : s.members.length >= s.capacity
                        ? "Full"
                        : "Join request"}
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Empty
          icon="users"
          title="Your next teammate hasn’t posted yet"
          description="Open a real squad with your game, platform, mic preference and time. Others can request to join."
          action="Open the first squad"
          onAction={onCreate}
        />
      )}
      {confirm && (
        <Confirm
          title={confirm.uid ? "Approve this player?" : "Send a join request?"}
          description={
            confirm.uid
              ? `Add this player to ${confirm.s.title}. Capacity and expiry will be checked again.`
              : `Request a spot in ${confirm.s.title}. The host will approve your request if a spot is available.`
          }
          label={confirm.uid ? "Approve player" : "Send request"}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await post(
              `/squads/${confirm.s.id}/${confirm.uid ? "approve" : "join"}`,
              { userId: confirm.uid, confirmed: true }
            );
            await refresh();
            toast.success(confirm.uid ? "Player approved." : "Request sent.");
          }}
        />
      )}
    </>
  );
}
