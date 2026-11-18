import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import {
  Scissors,
  Sparkles,
  ChevronLeft,
  Layers,
  Download,
  Share2,
  ExternalLink,
  Shield,
  Radio,
  Loader2,
  MessageSquare,
  Send,
} from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { downloadClip, refreshMedia } from "@/lib/media";
import { sourceTime } from "@/lib/player-state";
import {
  api,
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
  type Preferences,
  type ChatMessage,
} from "@shared/app-types";
import { Empty, Loading, ErrorPanel, Confirm } from "./Controls";

export function Media({
  url,
  poster,
  onTime,
  onLoaded,
  videoRef,
  loop = false,
}: {
  url?: string;
  poster?: string;
  onTime?: (time: number) => void;
  onLoaded?: () => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  loop?: boolean;
}) {
  const internal = useRef<HTMLVideoElement>(null);
  const ref = videoRef || internal;
  const latestUrl = useRef(url);
  latestUrl.current = url;
  const resourcePath = url?.split("?")[0];
  useEffect(() => {
    const video = ref.current;
    const initialUrl = latestUrl.current;
    if (!video || !initialUrl) return;
    let hls: Hls | undefined;
    if (initialUrl.includes(".m3u8") || initialUrl.includes("/hls")) {
      if (video.canPlayType("application/vnd.apple.mpegurl"))
        video.src = initialUrl;
      else if (Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(initialUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal)
            toast.error("Stream playback unavailable. Please try again.");
        });
      }
    } else video.src = initialUrl;
    // Metadata refreshes issue new scoped tickets, not a new video. Keep playback
    // continuous when clipping invalidates data; renew long-session tickets only.
    const renew = setInterval(async () => {
      if (
        !initialUrl.includes("ticket=") ||
        !resourcePath?.startsWith("/api/media/")
      )
        return;
      try {
        const ticket = await refreshMedia(
          resourcePath.slice("/api/media/".length)
        );
        const time = video.currentTime,
          playing = !video.paused;
        if (hls) hls.loadSource(ticket.url);
        else {
          video.addEventListener(
            "loadedmetadata",
            () => {
              video.currentTime = time;
              if (playing) video.play().catch(() => {});
            },
            { once: true }
          );
          video.src = ticket.url;
        }
      } catch {
        /* Existing cookie-authorized playback may still be valid. */
      }
    }, 240000);
    return () => {
      clearInterval(renew);
      hls?.destroy();
    };
  }, [resourcePath, ref]);
  return (
    <video
      ref={ref}
      controls
      playsInline
      preload="metadata"
      crossOrigin="anonymous"
      poster={poster}
      loop={loop}
      onTimeUpdate={e => onTime?.(e.currentTarget.currentTime)}
      onLoadedMetadata={onLoaded}
      onError={() =>
        toast.error(
          "This video could not be played. Check access or try again."
        )
      }
    />
  );
}
export default function PlayerPage({
  id,
  isClip,
  onSidekick,
  onEdit,
}: {
  id: string;
  isClip?: boolean;
  onSidekick: (context: {
    sourceId?: string;
    clipId?: string;
    position?: number;
  }) => void;
  onEdit: (clip: Clip) => void;
}) {
  const sourceQ = useData<Source>(`/sources/${id}`, !isClip),
    clipQ = useData<Clip>(`/clips/${id}`, !!isClip);
  const clip = clipQ.data;
  const original = useData<Source>(
    `/sources/${clip?.sourceId}`,
    !!isClip && !!clip?.sourceId
  );
  const source = isClip ? original.data : sourceQ.data;
  const item = isClip ? clip : source;
  const { user } = useAuth();
  const prefQ = useData<Preferences>("/settings", !!user);
  const prefs = prefQ.data || defaultPreferences;
  const [time, setTime] = useState(0),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState(""),
    [sendConfirm, setSendConfirm] = useState(false),
    [transcribeConfirm, setTranscribeConfirm] = useState(false),
    [downloading, setDownloading] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const refresh = useRefresh();
  const [, navigate] = useLocation();
  const search = useSearch();
  const seekInitial = () => {
    const value = Number(new URLSearchParams(search).get("t"));
    if (video.current && !isClip && Number.isFinite(value))
      video.current.currentTime = Math.min(
        video.current.duration || Infinity,
        Math.max(0, value)
      );
  };
  useEffect(() => {
    if (video.current?.readyState && new URLSearchParams(search).has("t"))
      seekInitial();
  }, [search, id, isClip]);
  const chat = useData<ChatMessage[]>(`/chat?sourceId=${source?.id}`, !!source);
  const canClip =
    !!source &&
    !!user &&
    (source.allowClip !== "creator" || source.creatorId === user.id) &&
    !isClip;
  async function clipThat() {
    if (!canClip || !source || saving) return;
    setSaving(true);
    const position = video.current?.currentTime ?? time;
    try {
      const saved = await post<Clip>("/clips", {
        sourceId: source.id,
        position,
        duration: prefs.clipDuration,
      });
      await refresh();
      toast(
        saved.status === "bookmarked"
          ? "Moment bookmarked"
          : "Saved. Keep watching.",
        {
          description:
            saved.status === "bookmarked"
              ? saved.footageNote
              : `${seconds(saved.end - saved.start)} in your private Clip Tray`,
          duration: 8000,
          action: { label: "Edit", onClick: () => onEdit(saved) },
          cancel: {
            label: "Undo",
            onClick: () => {
              api(`/clips/${saved.id}`, { method: "DELETE" })
                .then(() => {
                  refresh();
                  toast.success("Clip removed.");
                })
                .catch(e => toast.error(errorMessage(e)));
            },
          },
        }
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (
        e.key.toLowerCase() !== "c" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      e.preventDefault();
      clipThat();
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [source, time, saving, prefs.clipDuration, user]);
  const loading = isClip ? clipQ.isLoading : sourceQ.isLoading,
    error = isClip ? clipQ.error : sourceQ.error;
  if (loading) return <Loading />;
  if (error) return <ErrorPanel error={error} />;
  if (!item)
    return (
      <Empty
        title="This moment is unavailable"
        description="It may be private, removed, or still processing."
      />
    );
  return (
    <div className="watch-page">
      <Link className="back-link" href={isClip ? "/tray" : "/"}>
        <ChevronLeft size={17} />
        Back to {isClip ? "your moments" : "Discover"}
      </Link>
      <div className="watch-layout">
        <div>
          <div className="player-stage">
            {item.status === "ready" || item.status === "live" ? (
              <Media
                url={item.playbackUrl}
                poster={item.posterUrl}
                videoRef={video}
                onTime={setTime}
                onLoaded={seekInitial}
              />
            ) : (
              <div className="player-pending">
                <Radio size={34} />
                <h3>
                  {item.status === "bookmarked"
                    ? "Moment bookmarked"
                    : item.status === "error"
                      ? "Processing failed"
                      : "Preparing your footage"}
                </h3>
                <p>
                  {"footageNote" in item
                    ? item.footageNote
                    : "error" in item
                      ? item.error
                      : "This page updates when the video is ready."}
                </p>
              </div>
            )}
          </div>
          <div className="player-actions">
            <div className="play-state">
              {source?.kind === "live" ? (
                <>
                  <span className="live-dot" />
                  Live · viewed {seconds(time)}
                </>
              ) : (
                <>
                  <FilmMark />
                  {seconds(time)}{" "}
                  <span>
                    /{" "}
                    {seconds(
                      isClip ? clip!.end - clip!.start : source?.duration || 0
                    )}
                  </span>
                </>
              )}
            </div>
            <div>
              <Link href="/tray" className="btn small">
                <Layers size={17} />
                Clip Tray
              </Link>
              <button
                className="btn small sidekick-btn"
                onClick={() =>
                  onSidekick({
                    sourceId: source?.id,
                    clipId: clip?.id,
                    position: sourceTime(
                      video.current?.currentTime ?? time,
                      isClip ? clip?.start : 0
                    ),
                  })
                }
              >
                <Sparkles size={17} />
                Sidekick
              </button>
              {canClip && (
                <button
                  className="btn primary clip-btn"
                  onClick={clipThat}
                  disabled={saving}
                >
                  {saving ? (
                    <Loader2 className="spin" size={18} />
                  ) : (
                    <Scissors size={18} />
                  )}
                  Clip That<kbd>C</kbd>
                </button>
              )}
            </div>
          </div>
          <div className="watch-title">
            <span className="eyebrow">
              {item.game} <span> / </span>
              {isClip ? "CLIP" : source?.kind === "upload" ? "VIDEO" : "STREAM"}
            </span>
            <h1>{item.title}</h1>
            <div className="creator-line">
              <div className="avatar">
                {item.creatorName?.slice(0, 1).toUpperCase() || "R"}
              </div>
              <div>
                <strong>{item.creatorName}</strong>
                <small>
                  {isClip
                    ? `Clipped by ${clip?.ownerName}`
                    : "Original creator"}
                </small>
              </div>
              <span className="audience-pill">
                <Shield size={13} />
                {item.audience === "lounge" ? "Lounge audience" : "Public"}
              </span>
            </div>
          </div>
          {isClip && (
            <div className="clip-meta-actions">
              <button
                className="btn"
                onClick={() =>
                  navigate(`/watch/${clip!.sourceId}?t=${clip!.start}`)
                }
              >
                <ExternalLink size={16} />
                Watch original · {seconds(clip!.start)}
              </button>
              {user?.id === clip?.ownerId && (
                <button className="btn" onClick={() => onEdit(clip!)}>
                  Edit clip
                </button>
              )}
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(
                      `${window.location.origin}/clip/${id}`
                    );
                    toast.success(
                      "Link copied. Original access rules still apply."
                    );
                  } catch {
                    toast.error("Copy the address from your browser to share.");
                  }
                }}
              >
                <Share2 size={16} />
                Share link
              </button>
              {source?.allowDownload && (
                <button
                  className="btn"
                  disabled={downloading}
                  onClick={async () => {
                    setDownloading(true);
                    const notice = toast.loading("Downloading your clip…");
                    try {
                      await downloadClip(id, clip!.title, percent =>
                        toast.loading(`Downloading ${percent}%…`, {
                          id: notice,
                        })
                      );
                      toast.success("Download ready.", { id: notice });
                    } catch (e) {
                      toast.error(errorMessage(e), { id: notice });
                    } finally {
                      setDownloading(false);
                    }
                  }}
                >
                  <Download size={16} />
                  {downloading ? "Downloading…" : "Download"}
                </button>
              )}
            </div>
          )}
          <div className="permissions-note">
            <Shield size={15} />
            {source?.allowClip === "creator"
              ? "Only the creator can clip this video."
              : "Clips keep the original audience and credit."}{" "}
            {source?.transcriptionStatus &&
              `Transcription: ${source.transcriptionStatus}`}
          </div>
          {!isClip &&
            source?.creatorId === user?.id &&
            source?.status === "ready" && (
              <button
                className="btn small"
                disabled={["queued", "processing", "ready"].includes(
                  source?.transcriptionStatus || ""
                )}
                onClick={() => setTranscribeConfirm(true)}
              >
                <Sparkles size={15} />
                {source?.transcriptionStatus === "ready"
                  ? "Transcript ready"
                  : source?.transcriptionStatus === "queued" ||
                      source?.transcriptionStatus === "processing"
                    ? "Transcribing real audio…"
                    : "Generate source transcript"}
              </button>
            )}
        </div>
        <aside className="stream-chat">
          <div className="section-head">
            <h3>
              <MessageSquare size={17} />
              The conversation
            </h3>
            <span className="tiny">SOURCE CHAT</span>
          </div>
          <div className="chat-scroll">
            {chat.isLoading ? (
              <Loading />
            ) : chat.data?.length ? (
              chat.data.map(m => (
                <div className="chat-row" key={m.id}>
                  <strong>{m.name}</strong>
                  <span>{seconds(m.position)}</span>
                  <p>{m.text}</p>
                </div>
              ))
            ) : (
              <div className="chat-empty">
                <MessageSquare size={26} />
                <p>The conversation starts with you.</p>
                <small>Messages are visible to the source audience.</small>
              </div>
            )}
          </div>
          <form
            onSubmit={e => {
              e.preventDefault();
              if (message.trim()) setSendConfirm(true);
            }}
          >
            <input
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={
                user
                  ? "Say something good…"
                  : "Sign in to join the conversation"
              }
              disabled={!user}
              maxLength={500}
            />
            <button
              className="icon-btn"
              disabled={!user || !message.trim()}
              aria-label="Send message"
            >
              <Send size={17} />
            </button>
          </form>
        </aside>
      </div>
      {sendConfirm && (
        <Confirm
          title="Send this message?"
          description={message}
          label="Send message"
          onClose={() => setSendConfirm(false)}
          onConfirm={async () => {
            await post("/chat", {
              sourceId: source!.id,
              text: message,
              position: sourceTime(
                video.current?.currentTime ?? time,
                isClip ? clip?.start : 0
              ),
              confirmed: true,
            });
            setMessage("");
            await refresh();
          }}
        />
      )}
      {transcribeConfirm && (
        <Confirm
          title="Generate this video's transcript?"
          description="This sends the original video’s audio to the speech service. Usage may consume your app’s credits. The transcript enables timestamp search, catch-up and caption drafts for the source audience."
          label="Confirm & transcribe"
          onClose={() => setTranscribeConfirm(false)}
          onConfirm={async () => {
            await post(`/sources/${source!.id}/transcribe`, {
              confirmed: true,
            });
            await refresh();
            toast.success("Source transcription queued.");
          }}
        />
      )}
    </div>
  );
}
function FilmMark() {
  return <span className="video-dot" />;
}
