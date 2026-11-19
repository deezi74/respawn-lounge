import { useState, type ReactNode } from "react";
import {
  X,
  Loader2,
  Plus,
  ArrowUpRight,
  Shield,
  Radio,
  Film,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { api, post, errorMessage, useRefresh } from "@/lib/app-api";
import { localDateTime } from "@/lib/player-state";
import type { Lounge, Squad, Source } from "@shared/app-types";

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-shade"
      onMouseDown={e => e.target === e.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-btn"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Empty({
  icon = "film",
  title,
  description,
  action,
  onAction,
}: {
  icon?: string;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  const Icon = icon === "users" ? Users : icon === "radio" ? Radio : Film;
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={29} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && (
        <button className="btn primary" onClick={onAction}>
          <Plus size={17} />
          {action}
        </button>
      )}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <Loader2 className="spin" size={21} /> Loading your space…
    </div>
  );
}
export function ErrorPanel({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="error-panel">
      <p>{errorMessage(error)}</p>
      {retry && (
        <button onClick={retry} className="btn small">
          Try again
        </button>
      )}
    </div>
  );
}
export function Confirm({
  title,
  description,
  label = "Confirm",
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  label?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="confirm-copy">{description}</p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 size={17} className="spin" /> : null}
          {label}
        </button>
      </div>
    </Modal>
  );
}
export function UploadDialog({
  lounges,
  onClose,
  onUploaded,
}: {
  lounges: Lounge[];
  onClose: () => void;
  onUploaded: (source: Source) => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [title, setTitle] = useState(""),
    [game, setGame] = useState(""),
    [audience, setAudience] = useState("public"),
    [loungeId, setLoungeId] = useState(""),
    [clip, setClip] = useState("everyone"),
    [pub, setPub] = useState(true),
    [download, setDownload] = useState(false),
    [busy, setBusy] = useState(false);
  const refresh = useRefresh();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) {
      toast.error("Choose a video under 100 MB.");
      return;
    }
    setBusy(true);
    const form = new FormData();
    Object.entries({
      title,
      game,
      audience,
      loungeId,
      allowClip: clip,
      allowPublish: String(pub),
      allowDownload: String(download),
    }).forEach(([k, v]) => form.append(k, v));
    form.append("file", file);
    try {
      const source = await api<Source>("/upload", {
        method: "POST",
        body: form,
      });
      await refresh();
      toast.success("Video uploaded. Processing your footage.");
      onUploaded(source);
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Share your gameplay"
      subtitle="Your footage. Your audience. Your rules."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label className={`upload-zone ${file ? "has-file" : ""}`}>
          <Film size={30} />
          <strong>{file ? file.name : "Choose a gameplay video"}</strong>
          <span>MP4, MOV or WebM · up to 100 MB</span>
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            required
            onChange={e => {
              const f = e.target.files?.[0] || null;
              setFile(f);
              if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
            }}
          />
        </label>
        <Field label="Video title">
          <input
            required
            maxLength={120}
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="That one match worth remembering"
          />
        </Field>
        <Field label="Game">
          <input
            required
            maxLength={60}
            value={game}
            onChange={e => setGame(e.target.value)}
            placeholder="e.g. VALORANT"
          />
        </Field>
        <div className="form-pair">
          <Field label="Who can watch?">
            <select
              value={audience}
              onChange={e => setAudience(e.target.value)}
            >
              <option value="public">Everyone</option>
              <option value="lounge">A Lounge</option>
            </select>
          </Field>
          <Field label="Who can clip?">
            <select value={clip} onChange={e => setClip(e.target.value)}>
              <option value="everyone">Everyone</option>
              <option value="members">Lounge members</option>
              <option value="creator">Only me</option>
            </select>
          </Field>
        </div>
        {audience === "lounge" && (
          <Field
            label="Lounge"
            hint="Clips keep this audience. A private source cannot be posted publicly."
          >
            <select
              required
              value={loungeId}
              onChange={e => setLoungeId(e.target.value)}
            >
              <option value="">Choose your Lounge</option>
              {lounges.map(l => (
                <option value={l.id} key={l.id}>
                  {l.name} ({l.privacy})
                </option>
              ))}
            </select>
          </Field>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={pub}
            onChange={e => setPub(e.target.checked)}
          />{" "}
          Allow viewers to publish clips within the original audience
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={download}
            onChange={e => setDownload(e.target.checked)}
          />{" "}
          Allow downloads
        </label>
        <div className="inline-note">
          <Shield size={15} />
          Access and clipping rules are checked on the server.
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !file}>
            {busy ? (
              <Loader2 size={17} className="spin" />
            ) : (
              <ArrowUpRight size={17} />
            )}{" "}
            {busy ? "Uploading…" : "Upload video"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function CreateDialog({
  kind,
  onClose,
}: {
  kind: "lounge" | "squad";
  onClose: () => void;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [game, setGame] = useState(""),
    [privacy, setPrivacy] = useState("private"),
    [platform, setPlatform] = useState("PC"),
    [mic, setMic] = useState("optional"),
    [vibe, setVibe] = useState("Chill"),
    [capacity, setCapacity] = useState(4),
    [busy, setBusy] = useState(false),
    [starts, setStarts] = useState(
      localDateTime(new Date(Date.now() + 3600000))
    );
  const refresh = useRefresh();
  const isLounge = kind === "lounge";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (isLounge)
        await post<Lounge>("/lounges", { name, description, game, privacy });
      else
        await post<Squad>("/squads", {
          title: name,
          game,
          platform,
          mic,
          vibe,
          capacity,
          startsAt: new Date(starts).toISOString(),
          expiresAt: new Date(
            new Date(starts).getTime() + 4 * 3600000
          ).toISOString(),
        });
      await refresh();
      toast.success(
        isLounge ? "Your Lounge is ready." : "Squad is open. Find your people."
      );
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={isLounge ? "Make room for your people" : "Find your next squad"}
      subtitle={
        isLounge
          ? "Build a space for your shared moments."
          : "Keep it chill. Make the details clear."
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Field label={isLounge ? "Lounge name" : "Squad title"}>
          <input
            required
            maxLength={80}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={
              isLounge ? "The after-hours crew" : "Chill games, no pressure"
            }
          />
        </Field>
        <Field label="Game">
          <input
            required
            maxLength={60}
            value={game}
            onChange={e => setGame(e.target.value)}
            placeholder="What are we playing?"
          />
        </Field>
        {isLounge ? (
          <>
            <Field label="About this Lounge">
              <textarea
                value={description}
                maxLength={500}
                onChange={e => setDescription(e.target.value)}
                placeholder="A little about your corner of the gaming world"
              />
            </Field>
            <Field label="Privacy">
              <select
                value={privacy}
                onChange={e => setPrivacy(e.target.value)}
              >
                <option value="private">Private · membership required</option>
                <option value="public">Public · anyone can discover</option>
              </select>
            </Field>
          </>
        ) : (
          <>
            <div className="form-pair">
              <Field label="Platform">
                <select
                  value={platform}
                  onChange={e => setPlatform(e.target.value)}
                >
                  {[
                    "PC",
                    "PlayStation",
                    "Xbox",
                    "Nintendo Switch",
                    "Mobile",
                    "Cross-play",
                  ].map(p => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="Squad size">
                <input
                  type="number"
                  min={2}
                  max={16}
                  required
                  value={capacity}
                  onChange={e => setCapacity(Number(e.target.value))}
                />
              </Field>
            </div>
            <div className="form-pair">
              <Field label="Mic">
                <select value={mic} onChange={e => setMic(e.target.value)}>
                  <option value="optional">Mic optional</option>
                  <option value="required">Mic required</option>
                  <option value="no-mic">No mic</option>
                </select>
              </Field>
              <Field label="Vibe">
                <select value={vibe} onChange={e => setVibe(e.target.value)}>
                  {["Chill", "Competitive", "Learning"].map(v => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              label="Start time"
              hint="The listing expires four hours after this time."
            >
              <input
                type="datetime-local"
                required
                value={starts}
                onChange={e => setStarts(e.target.value)}
              />
            </Field>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            Create {kind}
          </button>
        </div>
      </form>
    </Modal>
  );
}
