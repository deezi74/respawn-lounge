import { useEffect, useRef, useState } from "react";
import {
  Settings2,
  Sparkles,
  Mic,
  MicOff,
  Shield,
  Save,
  Radio,
  Film,
  ArrowUpRight,
  Upload,
  Calendar,
  Monitor,
  Loader2,
  Trash2,
  Check,
  Clock,
  Scissors,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { api, patch, useData, useRefresh, errorMessage } from "@/lib/app-api";
import { localDateTime } from "@/lib/player-state";
import {
  defaultPreferences,
  type Preferences,
  type StudioSettings,
  type Source,
} from "@shared/app-types";
import { Field, Loading, ErrorPanel, Confirm, Empty } from "./Controls";
import { Link } from "wouter";
export function MemberSettings() {
  const q = useData<Preferences>("/settings");
  const [p, setP] = useState<Preferences>(defaultPreferences),
    [busy, setBusy] = useState(false),
    [clear, setClear] = useState(false);
  const refresh = useRefresh();
  useEffect(() => {
    if (q.data) setP(q.data);
  }, [q.data]);
  const set = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setP(v => ({ ...v, [key]: value }));
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorPanel error={q.error} />;
  return (
    <div className="settings-page">
      <div className="page-heading">
        <span className="eyebrow">YOUR SPACE. YOUR SETTINGS.</span>
        <h1>Make it personal.</h1>
        <p>Your profile, social options and Sidekick—all in your hands.</p>
      </div>
      <Link href="/profile/edit" className="settings-profile-entry">
        <Settings2 size={25} />
        <div>
          <strong>Your profile. No default settings.</strong>
          <span>
            Background photos/videos, ghost images, avatars, custom colors,
            layouts, social links and privacy.
          </span>
        </div>
        <ArrowUpRight size={20} />
      </Link>
      <div className="settings-columns">
        <section className="settings-card">
          <div className="settings-card-head">
            <Sparkles size={22} />
            <div>
              <h2>Your Sidekick</h2>
              <p>Optional by design. Yours by choice.</p>
            </div>
          </div>
          <label className="switch-row">
            <div>
              <strong>Enable my Gaming Sidekick</strong>
              <small>Text, voice input, and helpful app actions</small>
            </div>
            <input
              type="checkbox"
              checked={p.enabled}
              onChange={e => set("enabled", e.target.checked)}
            />
          </label>
          <Field label="Sidekick name">
            <input
              value={p.name}
              maxLength={30}
              onChange={e => set("name", e.target.value)}
            />
          </Field>
          <Field label="Avatar">
            <div className="avatar-choices">
              {["orbit", "bolt", "pixel", "ghost"].map(a => (
                <button
                  key={a}
                  className={p.avatar === a ? "selected" : ""}
                  onClick={() => set("avatar", a)}
                >
                  <span>
                    {a === "orbit"
                      ? "◉"
                      : a === "bolt"
                        ? "ϟ"
                        : a === "pixel"
                          ? "▦"
                          : "◈"}
                  </span>
                  {a}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Tone">
            <div className="segmented">
              {(["Chill", "Hype", "Straight to the Point"] as const).map(t => (
                <button
                  className={p.tone === t ? "selected" : ""}
                  key={t}
                  onClick={() => set("tone", t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Accent color">
            <div className="color-choices">
              {["#00E5FF", "#A855F7", "#FF3DA6", "#B6FF3B", "#FFCA47"].map(
                c => (
                  <button
                    aria-label={`Accent ${c}`}
                    key={c}
                    style={{ background: c }}
                    className={p.accent === c ? "selected" : ""}
                    onClick={() => set("accent", c)}
                  >
                    {p.accent === c && <Check size={17} />}
                  </button>
                )
              )}
              <input
                aria-label="Custom accent"
                type="color"
                value={p.accent}
                onChange={e => set("accent", e.target.value)}
              />
            </div>
          </Field>
        </section>
        <div>
          <section className="settings-card">
            <div className="settings-card-head">
              <Scissors size={21} />
              <div>
                <h2>One tap. Your timing.</h2>
                <p>Capture the previous available seconds.</p>
              </div>
            </div>
            <Field label="Default clip duration">
              <div className="segmented">
                {([15, 30, 60] as const).map(d => (
                  <button
                    key={d}
                    className={p.clipDuration === d ? "selected" : ""}
                    onClick={() => set("clipDuration", d)}
                  >
                    {d} seconds
                  </button>
                ))}
              </div>
            </Field>
            <p className="inline-note">
              Press <kbd>C</kbd> on desktop. Playback keeps going.
            </p>
          </section>
          <section className="settings-card">
            <div className="settings-card-head">
              <Shield size={21} />
              <div>
                <h2>Personalization, on your terms</h2>
                <p>See what’s saved. Clear it whenever.</p>
              </div>
            </div>
            <label className="switch-row">
              <div>
                <strong>Save my gaming preferences</strong>
                <small>Opt in to better squad suggestions</small>
              </div>
              <input
                type="checkbox"
                checked={p.personalization}
                onChange={e => set("personalization", e.target.checked)}
              />
            </label>
            <Field
              label="Selected games"
              hint={
                p.personalization
                  ? "These preferences will be saved."
                  : "Enable personalization to save squad preferences."
              }
            >
              <input
                disabled={!p.personalization}
                value={p.games.join(", ")}
                onChange={e =>
                  set(
                    "games",
                    e.target.value
                      .split(",")
                      .map(x => x.trim())
                      .filter(Boolean)
                  )
                }
                placeholder="VALORANT, Apex Legends…"
              />
            </Field>
            <div className="form-pair">
              <Field label="Platform">
                <select
                  disabled={!p.personalization}
                  value={p.platform}
                  onChange={e => set("platform", e.target.value)}
                >
                  {[
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
              </Field>
              <Field label="Mic preference">
                <select
                  disabled={!p.personalization}
                  value={p.mic}
                  onChange={e => set("mic", e.target.value)}
                >
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                  <option value="no-mic">No mic</option>
                </select>
              </Field>
            </div>
            <Field label="Availability">
              <input
                disabled={!p.personalization}
                value={p.availability}
                onChange={e => set("availability", e.target.value)}
                maxLength={80}
                placeholder="Tonight"
              />
            </Field>
            <button className="text-btn danger" onClick={() => setClear(true)}>
              <Trash2 size={15} />
              Clear saved personalization
            </button>
          </section>
        </div>
      </div>
      <div className="settings-save">
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await patch("/settings", p);
              await refresh();
              toast.success("Settings saved. Your Sidekick, your way.");
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={17} className="spin" /> : <Save size={17} />}
          Save settings
        </button>
      </div>
      {clear && (
        <Confirm
          title="Clear saved personalization?"
          description="This resets your saved gaming preferences and Sidekick personalization. Your clips and operational clip-duration setting are kept."
          label="Clear preferences"
          onClose={() => setClear(false)}
          onConfirm={async () => {
            await api("/settings", { method: "DELETE" });
            await refresh();
            toast.success("Saved personalization cleared.");
          }}
        />
      )}
    </div>
  );
}
export function Studio({ onUpload }: { onUpload: () => void }) {
  const q = useData<StudioSettings>("/studio"),
    sourcesQ = useData<Source[]>("/sources");
  const { user } = useAuth();
  const [title, setTitle] = useState(""),
    [game, setGame] = useState(""),
    [scheduled, setScheduled] = useState(""),
    [busy, setBusy] = useState(false),
    [micOn, setMicOn] = useState(false),
    [micLevel, setMicLevel] = useState(0);
  const mic = useRef<MediaStream | null>(null),
    ctx = useRef<AudioContext | null>(null),
    frame = useRef(0);
  const refresh = useRefresh();
  useEffect(() => {
    if (q.data) {
      setTitle(q.data.title || "");
      setGame(q.data.game || "");
      setScheduled(q.data.scheduledAt ? localDateTime(q.data.scheduledAt) : "");
    }
  }, [q.data]);
  function stopMic() {
    cancelAnimationFrame(frame.current);
    mic.current?.getTracks().forEach(t => t.stop());
    ctx.current?.close();
    setMicOn(false);
    setMicLevel(0);
  }
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      mic.current?.getTracks().forEach(t => t.stop());
      ctx.current?.close();
    },
    []
  );
  async function checkMic() {
    if (micOn) {
      stopMic();
      return;
    }
    try {
      mic.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx.current = new AudioContext();
      const analyser = ctx.current.createAnalyser();
      ctx.current.createMediaStreamSource(mic.current).connect(analyser);
      analyser.fftSize = 256;
      const values = new Uint8Array(analyser.frequencyBinCount);
      setMicOn(true);
      function tick() {
        analyser.getByteFrequencyData(values);
        setMicLevel(
          Math.min(100, (values.reduce((a, b) => a + b, 0) / values.length) * 2)
        );
        frame.current = requestAnimationFrame(tick);
      }
      tick();
    } catch {
      toast.error(
        "Microphone unavailable. Check browser permission and your input device."
      );
    }
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorPanel error={q.error} />;
  const own = sourcesQ.data?.filter(s => s.creatorId === user?.id) || [];
  return (
    <div className="studio-page">
      <div className="page-heading row">
        <div>
          <span className="eyebrow">CREATOR STUDIO</span>
          <h1>Your next good moment.</h1>
          <p>Upload your gameplay. Set your audience. Keep your voice.</p>
        </div>
        <button className="btn primary" onClick={onUpload}>
          <Upload size={17} />
          Upload video
        </button>
      </div>
      <div className="studio-columns">
        <section className="settings-card">
          <div className="settings-card-head">
            <Radio size={23} />
            <div>
              <h2>Stream setup</h2>
              <p>Actual settings. No surprise broadcasts.</p>
            </div>
          </div>
          <div className="provider-disconnected">
            <span className="status-orb" />
            <strong>Live provider disconnected</strong>
            <p>
              Live broadcasting is disabled by your choice. Uploaded videos and
              clipping work independently.
            </p>
            <span className="mini-tag">Cloudflare Stream · not connected</span>
          </div>
          <Field label="Stream title">
            <input
              value={title}
              maxLength={120}
              onChange={e => setTitle(e.target.value)}
              placeholder="Late-night games with the crew"
            />
          </Field>
          <Field label="Game">
            <input
              value={game}
              maxLength={60}
              onChange={e => setGame(e.target.value)}
              placeholder="What are you playing?"
            />
          </Field>
          <Field
            label="Planned stream time"
            hint="Saves your plan. It does not start a broadcast or notify members."
          >
            <input
              type="datetime-local"
              value={scheduled}
              onChange={e => setScheduled(e.target.value)}
            />
          </Field>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await patch("/studio", {
                  title,
                  game,
                  scheduledAt: scheduled
                    ? new Date(scheduled).toISOString()
                    : null,
                });
                await refresh();
                toast.success("Studio settings saved.");
              } catch (e) {
                toast.error(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Save size={16} />
            Save stream plan
          </button>
        </section>
        <div>
          <section className="settings-card">
            <div className="settings-card-head">
              <Mic size={21} />
              <div>
                <h2>Sound check</h2>
                <p>Check your actual microphone, right here.</p>
              </div>
            </div>
            <div className="mic-meter">
              <div style={{ width: `${micLevel}%` }} />
            </div>
            <div className="mic-check-row">
              <span className={micOn ? "mic-live" : ""}>
                {micOn ? "Microphone on · not recording" : "Microphone off"}
              </span>
              <button className="btn" onClick={checkMic}>
                {micOn ? <MicOff size={16} /> : <Mic size={16} />}{" "}
                {micOn ? "Stop check" : "Check mic"}
              </button>
            </div>
            <p className="muted small-copy">
              This meter runs locally. Audio is not saved or sent.
            </p>
          </section>
          <section className="studio-tip">
            <span className="eyebrow">GOOD TO KNOW</span>
            <h2>
              Your gameplay.
              <br />
              Your permissions.
            </h2>
            <p>
              Set who can watch, clip, publish, and download each upload.
              Private footage stays private—even when a link is shared.
            </p>
            <Shield size={30} />
          </section>
        </div>
      </div>
      <div className="section-head">
        <h2>Your video library</h2>
        <span className="tiny">{own.length} UPLOADS</span>
      </div>
      {own.length ? (
        <div className="studio-library">
          {own.map(s => (
            <div className="library-row" key={s.id}>
              <div className="library-thumb">
                {s.posterUrl ? (
                  <img src={s.posterUrl} alt={s.title} />
                ) : (
                  <Film size={24} />
                )}
              </div>
              <div>
                <Link href={`/watch/${s.id}`}>
                  <strong>{s.title}</strong>
                </Link>
                <span>
                  {s.game} ·{" "}
                  {s.audience === "lounge" ? "Lounge audience" : "Public"} ·{" "}
                  {s.status}
                </span>
              </div>
              <Link className="btn small" href={`/watch/${s.id}`}>
                Open
                <ArrowUpRight size={14} />
              </Link>
              <SourcePermissions source={s} refresh={refresh} />
            </div>
          ))}
        </div>
      ) : (
        <Empty
          title="Your library starts here"
          description="Upload a real gameplay video to start watching, clipping and sharing."
          action="Upload your first video"
          onAction={onUpload}
        />
      )}
    </div>
  );
}
function SourcePermissions({
  source,
  refresh,
}: {
  source: Source;
  refresh: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [clip, setClip] = useState(source.allowClip),
    [pub, setPub] = useState(source.allowPublish),
    [download, setDownload] = useState(source.allowDownload);
  return (
    <>
      <button
        className="icon-btn"
        onClick={() => setOpen(!open)}
        aria-label="Creator permission controls"
      >
        <Settings2 size={19} />
      </button>
      {open && (
        <div className="source-permission-popover">
          <strong>Creator permissions</strong>
          <Field label="Who can clip">
            <select
              value={clip}
              onChange={e => setClip(e.target.value as Source["allowClip"])}
            >
              <option value="everyone">Everyone</option>
              <option value="members">Lounge members</option>
              <option value="creator">Only me</option>
            </select>
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={pub}
              onChange={e => setPub(e.target.checked)}
            />
            Allow clip publication
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={download}
              onChange={e => setDownload(e.target.checked)}
            />
            Allow downloads
          </label>
          <button
            className="btn primary small"
            onClick={async () => {
              try {
                await patch(`/sources/${source.id}`, {
                  allowClip: clip,
                  allowPublish: pub,
                  allowDownload: download,
                });
                await refresh();
                setOpen(false);
                toast.success("Creator permissions updated.");
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Save permissions
          </button>
        </div>
      )}
    </>
  );
}
