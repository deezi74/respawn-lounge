import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  X,
  Send,
  Mic,
  MicOff,
  Scissors,
  Smartphone,
  Users,
  Radio,
  Loader2,
  ArrowUpRight,
  SlidersHorizontal,
} from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
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
  type Preferences,
  type SidekickResult,
  type ServiceState,
  type Clip,
} from "@shared/app-types";
export type SidekickContext = {
  sourceId?: string;
  clipId?: string;
  position?: number;
};
export default function Sidekick({
  context,
  onClose,
  onEdit,
}: {
  context: SidekickContext;
  onClose: () => void;
  onEdit: (clip: Clip) => void;
}) {
  const { user } = useAuth();
  const settings = useData<Preferences>("/settings", !!user);
  const prefs = settings.data || defaultPreferences;
  const services = useData<ServiceState>("/services");
  const refresh = useRefresh();
  const [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [recording, setRecording] = useState(false),
    [messages, setMessages] = useState<
      { user?: string; result?: SidekickResult }[]
    >([]);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recordingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      if (recordingTimeout.current) clearTimeout(recordingTimeout.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach(t => t.stop());
    },
    []
  );
  async function send(text = input) {
    if (!text.trim() || busy) return;
    if (!user) {
      toast.error("Sign in to use your Sidekick.");
      return;
    }
    if (!prefs.enabled) {
      toast.error("Enable Sidekick in settings first.");
      return;
    }
    setInput("");
    setBusy(true);
    setMessages(m => [...m, { user: text }]);
    try {
      const player = document.querySelector<HTMLVideoElement>(
        ".player-stage video"
      );
      let position = context.position;
      if (player && context.sourceId) {
        if (window.location.pathname === `/watch/${context.sourceId}`)
          position = player.currentTime;
        else if (
          context.clipId &&
          window.location.pathname === `/clip/${context.clipId}`
        ) {
          const selected = await api<Clip>(`/clips/${context.clipId}`);
          position = selected.start + player.currentTime;
        }
      }
      const result = await post<SidekickResult>("/api/sidekick", {
        message: text,
        ...context,
        position,
      });
      setMessages(m => [...m, { result }]);
      await refresh();
      if (result.clip && result.action === "edit") onEdit(result.clip);
    } catch (e) {
      setMessages(m => [...m, { result: { message: errorMessage(e) } }]);
    } finally {
      setBusy(false);
    }
  }
  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast.error(
        "Voice input is not supported in this browser. Text works everywhere."
      );
      return;
    }
    if (!user || !prefs.enabled) return;
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const chunks: BlobPart[] = [];
      recorder.current = new MediaRecorder(stream.current);
      recorder.current.ondataavailable = e => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.current.onstop = async () => {
        stream.current?.getTracks().forEach(t => t.stop());
        if (!mounted.current) return;
        setRecording(false);
        const audio = new Blob(chunks, {
          type: recorder.current?.mimeType || "audio/webm",
        });
        const form = new FormData();
        form.append("file", audio, "voice.webm");
        setBusy(true);
        try {
          const r = await api<{ text: string }>("/voice", {
            method: "POST",
            body: form,
          });
          setInput(r.text);
          toast.success("Voice transcribed. Review it, then send.");
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      };
      recorder.current.start();
      setRecording(true);
      recordingTimeout.current = setTimeout(() => {
        if (recorder.current?.state === "recording") recorder.current.stop();
      }, 20000);
    } catch (e) {
      toast.error("Microphone access was denied or unavailable.");
    }
  }
  function close() {
    mounted.current = false;
    if (recordingTimeout.current) clearTimeout(recordingTimeout.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach(t => t.stop());
    onClose();
  }
  return (
    <aside
      className="sidekick-panel"
      role="dialog"
      aria-label="Gaming Sidekick"
      style={{ "--sidekick-color": prefs.accent } as React.CSSProperties}
    >
      <div className="sidekick-head">
        <div className="sidekick-orb">
          <Sparkles size={22} />
        </div>
        <div>
          <h3>{prefs.name}</h3>
          <span>Your gaming Sidekick · {prefs.tone}</span>
        </div>
        <button
          className="icon-btn"
          onClick={close}
          aria-label="Close Sidekick"
        >
          <X size={18} />
        </button>
      </div>
      <div className="sidekick-services">
        <span className={services.data?.ai ? "available" : ""}>
          <i />
          AI {services.data?.ai ? "available" : "unavailable"}
        </span>
        <Link href="/settings">
          <SlidersHorizontal size={13} />
          Personalize
        </Link>
      </div>
      <div className="sidekick-body">
        {!messages.length && (
          <>
            <span className="eyebrow">LESS WORK. MORE PLAY.</span>
            <h2>
              Good moments.
              <br />A little backup.
            </h2>
            <p>
              Save a play, polish a clip, or find your people. You’re always in
              control.
            </p>
            {!user && (
              <p className="inline-note">
                Sign in to make this Sidekick yours.
              </p>
            )}
            {!prefs.enabled && (
              <p className="inline-note">
                Sidekick is off. Enable it in your settings.
              </p>
            )}
            <div className="sidekick-prompts">
              {[
                {
                  Icon: Scissors,
                  text: "Clip that!",
                  sub: "Save what you just watched",
                  needs: !context.sourceId,
                },
                {
                  Icon: Smartphone,
                  text: "Turn this into a vertical clip with captions",
                  sub: "An editable draft, not a public post",
                  needs: !context.clipId,
                },
                {
                  Icon: Users,
                  text: "Find me a chill squad tonight",
                  sub: "Real openings, matched to your preferences",
                  needs: false,
                },
                {
                  Icon: Radio,
                  text: "Help me set up my stream",
                  sub: "Check your actual Studio settings",
                  needs: false,
                },
              ].map(p => (
                <button
                  key={p.text}
                  disabled={busy || p.needs || !user || !prefs.enabled}
                  onClick={() => send(p.text)}
                >
                  <p.Icon size={18} />
                  <div>
                    <strong>{p.text}</strong>
                    <small>{p.sub}</small>
                  </div>
                  <ArrowUpRight size={15} />
                </button>
              ))}
            </div>
            {context.sourceId && (
              <div className="extra-prompts">
                <button
                  onClick={() => send("Find where we all started laughing")}
                >
                  Find a laughing moment
                </button>
                <button onClick={() => send("Catch me up")}>Catch me up</button>
              </div>
            )}
            <p className="sidekick-footnote">
              Clip commands don’t need AI. Other actions depend on available
              footage and services.
            </p>
          </>
        )}
        {messages.map((m, i) =>
          m.user ? (
            <div key={i} className="sidekick-message user-message">
              {m.user}
            </div>
          ) : (
            <div key={i} className="sidekick-message">
              <div className="tiny">
                <Sparkles size={12} />
                {prefs.name}
              </div>
              <p>{m.result?.message}</p>
              {m.result?.basedOn && (
                <span className="mini-tag">Based on {m.result.basedOn}</span>
              )}
              {m.result?.clip && (
                <button
                  className="btn small"
                  onClick={() => onEdit(m.result!.clip!)}
                >
                  Open editable draft
                </button>
              )}
              {m.result?.moments?.map((moment, j) => (
                <Link
                  key={j}
                  className="moment-result"
                  href={`/watch/${context.sourceId}?t=${moment.position}`}
                >
                  <span>{seconds(moment.position)}</span>
                  {moment.text}
                  <ArrowUpRight size={14} />
                </Link>
              ))}
              {m.result?.squads?.map(s => (
                <Link key={s.id} href="/squads" className="moment-result">
                  <Users size={15} />
                  {s.title}
                  <span>
                    {s.members.length}/{s.capacity}
                  </span>
                </Link>
              ))}
              {m.result?.action === "studio" && (
                <Link className="btn small" href="/studio">
                  Open Studio
                </Link>
              )}
              {m.result?.action === "squads" && (
                <Link className="btn small" href="/squads">
                  Browse squads
                </Link>
              )}
              {m.result?.requiresConfirmation && (
                <p className="confirmation-needed">
                  Review and confirm this action in the app before it is sent or
                  published.
                </p>
              )}
            </div>
          )
        )}
        {busy && (
          <div className="sidekick-thinking">
            <Loader2 size={15} className="spin" />
            Working on it…
          </div>
        )}
      </div>
      <div className="sidekick-input">
        <form
          onSubmit={e => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={
              recording
                ? "Microphone on · recording…"
                : `Ask ${prefs.name} anything…`
            }
            maxLength={2000}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            disabled={busy || !user || !prefs.enabled}
          />
          <div>
            <button
              type="button"
              aria-label={recording ? "Stop recording" : "Push to talk"}
              className={`icon-btn ${recording ? "recording" : ""}`}
              onClick={() =>
                recording ? recorder.current?.stop() : startRecording()
              }
              disabled={busy || !user || !prefs.enabled}
            >
              {recording ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <span>
              {recording
                ? "Mic on · tap to stop"
                : "Review voice before sending"}
            </span>
            <button
              className="send-btn"
              disabled={busy || !input.trim() || !user || !prefs.enabled}
              aria-label="Send to Sidekick"
            >
              <Send size={16} />
            </button>
          </div>
        </form>
        <small>Drafts first. You confirm every public action.</small>
      </div>
    </aside>
  );
}
