import { useEffect, useRef, useState } from "react";
import {
  Scissors,
  Smartphone,
  Square,
  Monitor,
  Sparkles,
  Save,
  Share2,
  Loader2,
  Shield,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  api,
  patch,
  post,
  useData,
  useRefresh,
  seconds,
  errorMessage,
} from "@/lib/app-api";
import type { Clip, Source, Caption, Lounge, Crop } from "@shared/app-types";
import { Media } from "./Player";
import { Modal, Field, Confirm } from "./Controls";
import { trimmedCaptions } from "@/lib/player-state";
export default function ClipEditor({
  clip,
  onClose,
  onSidekick,
}: {
  clip: Clip;
  onClose: () => void;
  onSidekick: (context: {
    sourceId?: string;
    clipId?: string;
    position?: number;
  }) => void;
}) {
  const { user } = useAuth();
  const sourceQ = useData<Source>(`/sources/${clip.sourceId}`);
  const source = sourceQ.data;
  const currentClip = useData<Clip>(`/clips/${clip.id}`);
  const loungesQ = useData<Lounge[]>("/lounges");
  const refresh = useRefresh();
  const [title, setTitle] = useState(clip.title),
    [start, setStart] = useState(clip.start),
    [end, setEnd] = useState(clip.end),
    [crop, setCrop] = useState<Crop>(clip.crop),
    [x, setX] = useState(clip.cropX),
    [y, setY] = useState(clip.cropY),
    [captions, setCaptions] = useState<Caption[]>(clip.captions),
    [overlay, setOverlay] = useState(clip.overlay),
    [busy, setBusy] = useState(false),
    [transcribeConfirm, setTranscribeConfirm] = useState(false),
    [awaitingCaptions, setAwaitingCaptions] = useState(false),
    [publish, setPublish] = useState(false),
    [dest, setDest] = useState(
      clip.audience === "lounge" ? "lounge" : "profile"
    ),
    [loungeId, setLoungeId] = useState(clip.loungeId || ""),
    [previewTime, setPreviewTime] = useState(0),
    [thumbs, setThumbs] = useState<string[]>([]);
  const video = useRef<HTMLVideoElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const max = source?.duration || Math.max(clip.end, 60);
  const duration = end - start;
  const captionOrigin = useRef(clip.start);
  const transcription = currentClip.data?.transcriptionStatus;
  const transcriptionBusy =
    awaitingCaptions ||
    transcription === "queued" ||
    transcription === "processing";
  useEffect(() => {
    if (!awaitingCaptions) return;
    if (transcription === "ready") {
      setCaptions(currentClip.data?.captions || []);
      setAwaitingCaptions(false);
      toast.success(
        "Captions generated. Review and correct them before sharing."
      );
    } else if (transcription === "error") {
      setAwaitingCaptions(false);
      toast.error(
        currentClip.data?.transcriptionError || "Caption generation failed."
      );
    }
  }, [transcription, currentClip.data, awaitingCaptions]);
  const sourceIdentity = source?.playbackUrl?.split("?")[0];
  useEffect(() => {
    setCaptions(current =>
      trimmedCaptions(current, captionOrigin.current, start, end)
    );
    captionOrigin.current = start;
  }, [start, end]);
  useEffect(() => {
    if (video.current && video.current.readyState >= 1)
      video.current.currentTime = start;
  }, [start]);
  useEffect(() => {
    let cancelled = false;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.preload = "auto";
    if (!source?.playbackUrl || source.kind === "live") return;
    v.src = source.playbackUrl;
    const images: string[] = [];
    let i = 0;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    v.onloadedmetadata = () => {
      v.currentTime = Math.min(
        v.duration - 0.1,
        Math.max(0, (max * (i + 0.1)) / 8)
      );
    };
    v.onseeked = () => {
      if (cancelled) return;
      try {
        canvas.getContext("2d")?.drawImage(v, 0, 0, 160, 90);
        images.push(canvas.toDataURL("image/jpeg", 0.65));
      } catch {
        return;
      }
      i++;
      if (i < 8)
        v.currentTime = Math.min(v.duration - 0.1, (max * (i + 0.1)) / 8);
      else setThumbs(images);
    };
    return () => {
      cancelled = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [sourceIdentity, max]);
  const edit = {
    title,
    start,
    end,
    crop,
    cropX: x,
    cropY: y,
    captions,
    overlay,
  };
  async function save() {
    setBusy(true);
    try {
      const saved = await patch<Clip>(`/clips/${clip.id}`, edit);
      await refresh();
      toast.success("Edits saved. Rendering your playable clip.");
      return saved;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function publishClip() {
    setBusy(true);
    try {
      let saved = await patch<Clip>(`/clips/${clip.id}`, edit);
      if (saved.status !== "ready") {
        toast.info("Rendering before publication…");
        const deadline = Date.now() + 180000;
        while (saved.status !== "ready" && Date.now() < deadline) {
          if (saved.status === "error")
            throw new Error(saved.error || "Render failed.");
          if (saved.status === "bookmarked")
            throw new Error(
              "Footage is not yet available. This moment stays private."
            );
          await new Promise(r => setTimeout(r, 1800));
          saved = await api<Clip>(`/clips/${clip.id}`);
        }
        if (saved.status !== "ready")
          throw new Error(
            "Your clip is still rendering. Publish it from the tray once it is ready."
          );
      }
      await post(`/clips/${clip.id}/publish`, {
        destination: dest,
        loungeId: dest === "lounge" ? loungeId : undefined,
        confirmed: true,
      });
      await refresh();
      toast.success("Your moment is published.");
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const activeCaption = captions.find(
    c => previewTime - start >= c.start && previewTime - start < c.end
  );
  return (
    <Modal
      title="Make it your moment"
      subtitle={`Original footage by ${clip.creatorName} · edits stay private until you publish`}
      onClose={onClose}
      wide
    >
      <div className="editor-layout">
        <div className="editor-main">
          <div className="editor-preview-wrap">
            <div
              className={`editor-preview ${crop}`}
              onPointerDown={e => {
                if (crop === "original") return;
                if (
                  e.clientY >
                  e.currentTarget.getBoundingClientRect().bottom - 50
                )
                  return;
                drag.current = {
                  x: e.clientX,
                  y: e.clientY,
                  startX: x,
                  startY: y,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={e => {
                if (!drag.current) return;
                setX(
                  Math.max(
                    0,
                    Math.min(
                      1,
                      drag.current.startX +
                        (drag.current.x - e.clientX) /
                          e.currentTarget.clientWidth
                    )
                  )
                );
                setY(
                  Math.max(
                    0,
                    Math.min(
                      1,
                      drag.current.startY +
                        (drag.current.y - e.clientY) /
                          e.currentTarget.clientHeight
                    )
                  )
                );
              }}
              onPointerUp={() => (drag.current = null)}
              style={
                {
                  "--crop-x": `${x * 100}%`,
                  "--crop-y": `${y * 100}%`,
                } as React.CSSProperties
              }
            >
              {source?.playbackUrl ? (
                <Media
                  videoRef={video}
                  url={source.playbackUrl}
                  poster={source.posterUrl}
                  onLoaded={() => {
                    if (video.current) video.current.currentTime = start;
                  }}
                  onTime={t => {
                    setPreviewTime(t);
                    if (t >= end && video.current) {
                      video.current.currentTime = start;
                      video.current.play().catch(() => {});
                    }
                  }}
                />
              ) : (
                <div className="player-pending">
                  {clip.footageNote || "Loading original footage…"}
                </div>
              )}
              {activeCaption && (
                <div className="preview-caption">{activeCaption.text}</div>
              )}
              {overlay && <div className="preview-overlay">{overlay}</div>}
            </div>
          </div>
          <p className="crop-hint">
            <GripVertical size={14} />
            {crop === "original"
              ? "Original framing · preview loops your selected interval"
              : "Drag the picture to keep the action in frame"}
          </p>
          <div className="crop-options">
            {[
              { id: "original", Icon: Monitor, label: "Original" },
              { id: "vertical", Icon: Smartphone, label: "9:16 Vertical" },
              { id: "square", Icon: Square, label: "1:1 Square" },
            ].map(({ id, Icon, label }) => (
              <button
                key={id}
                className={crop === id ? "selected" : ""}
                onClick={() => setCrop(id as Crop)}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
          </div>
          {crop !== "original" && (
            <div className="form-pair">
              <Field label="Horizontal framing">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={x}
                  onChange={e => setX(Number(e.target.value))}
                />
              </Field>
              <Field label="Vertical framing">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={y}
                  onChange={e => setY(Number(e.target.value))}
                />
              </Field>
            </div>
          )}
          <div className="timeline-label">
            <strong>
              <Scissors size={15} />
              Trim your moment
            </strong>
            <span>{seconds(duration)} selected</span>
          </div>
          <div className="timeline">
            <div className="thumbnail-strip">
              {Array.from({ length: 8 }, (_, i) => (
                <img
                  key={i}
                  src={thumbs[i] || source?.posterUrl || clip.posterUrl}
                  alt="Timeline frame"
                />
              ))}
            </div>
            <div
              className="timeline-selected"
              style={{
                left: `${(start / max) * 100}%`,
                width: `${((end - start) / max) * 100}%`,
              }}
            />
            <input
              aria-label="Clip start handle"
              className="timeline-range start"
              type="range"
              min={0}
              max={max}
              step={0.1}
              value={start}
              onChange={e =>
                setStart(
                  Math.max(0, Math.min(Number(e.target.value), end - 0.3))
                )
              }
            />
            <input
              aria-label="Clip end handle"
              className="timeline-range end"
              type="range"
              min={0}
              max={max}
              step={0.1}
              value={end}
              onChange={e =>
                setEnd(
                  Math.max(
                    start + 0.3,
                    Math.min(Number(e.target.value), max, start + 60)
                  )
                )
              }
            />
          </div>
          <div className="form-pair time-fields">
            <Field label="Start (seconds)">
              <input
                type="number"
                step={0.1}
                min={0}
                max={end - 0.3}
                value={start}
                onChange={e =>
                  setStart(
                    Math.max(0, Math.min(Number(e.target.value), end - 0.3))
                  )
                }
              />
            </Field>
            <Field label="End (seconds)">
              <input
                type="number"
                step={0.1}
                min={start + 0.3}
                max={Math.min(max, start + 60)}
                value={end}
                onChange={e =>
                  setEnd(
                    Math.min(
                      max,
                      start + 60,
                      Math.max(start + 0.3, Number(e.target.value))
                    )
                  )
                }
              />
            </Field>
          </div>
        </div>
        <aside className="editor-details">
          <Field label="Clip title">
            <input
              value={title}
              maxLength={120}
              onChange={e => setTitle(e.target.value)}
            />
          </Field>
          <button
            className="btn sidekick-btn full"
            onClick={() =>
              onSidekick({
                clipId: clip.id,
                sourceId: clip.sourceId,
                position: clip.end,
              })
            }
          >
            <Sparkles size={16} />
            Make it vertical with captions
          </button>
          <div className="captions-head">
            <h3>Captions</h3>
            <button
              className="text-btn"
              onClick={() =>
                setCaptions([
                  ...captions,
                  { start: 0, end: Math.min(duration, 3), text: "" },
                ])
              }
            >
              <Plus size={14} />
              Add
            </button>
          </div>
          <p className="muted small-copy">
            Correct the words before sharing. Times are relative to your clip.
          </p>
          <button
            className="btn small full caption-generate"
            disabled={busy || transcriptionBusy}
            onClick={() => setTranscribeConfirm(true)}
          >
            {transcriptionBusy ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Sparkles size={14} />
            )}
            {transcriptionBusy
              ? "Generating real captions…"
              : "Generate captions"}
          </button>
          {currentClip.data?.transcriptionError && (
            <p className="error-copy small-copy">
              {currentClip.data.transcriptionError}
            </p>
          )}
          <div className="caption-list">
            {!captions.length && (
              <p className="caption-empty">
                No captions yet. Ask Sidekick or add your own.
              </p>
            )}
            {captions.map((c, i) => (
              <div className="caption-row" key={i}>
                <div>
                  <input
                    aria-label="Caption start"
                    type="number"
                    min={0}
                    step={0.1}
                    max={duration}
                    value={c.start}
                    onChange={e =>
                      setCaptions(
                        captions.map((v, j) =>
                          i === j ? { ...v, start: Number(e.target.value) } : v
                        )
                      )
                    }
                  />
                  <span>to</span>
                  <input
                    aria-label="Caption end"
                    type="number"
                    min={0}
                    step={0.1}
                    max={duration}
                    value={c.end}
                    onChange={e =>
                      setCaptions(
                        captions.map((v, j) =>
                          i === j ? { ...v, end: Number(e.target.value) } : v
                        )
                      )
                    }
                  />
                  <button
                    className="icon-btn"
                    aria-label="Remove caption"
                    onClick={() =>
                      setCaptions(captions.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <textarea
                  aria-label="Caption text"
                  value={c.text}
                  maxLength={200}
                  onChange={e =>
                    setCaptions(
                      captions.map((v, j) =>
                        i === j ? { ...v, text: e.target.value } : v
                      )
                    )
                  }
                />
              </div>
            ))}
          </div>
          <Field
            label="Optional overlay"
            hint="A short word or emoji overlay. Clear to remove."
          >
            <input
              value={overlay}
              maxLength={24}
              onChange={e => setOverlay(e.target.value)}
              placeholder="Your finishing touch"
            />
          </Field>
          <div className="inline-note">
            <Shield size={15} />
            {clip.audience === "lounge"
              ? "This clip stays within its original Lounge."
              : "The original creator is credited automatically."}
          </div>
          {publish && (
            <div className="publish-box">
              <h3>Confirm publication</h3>
              <Field label="Post to">
                <select value={dest} onChange={e => setDest(e.target.value)}>
                  {clip.audience === "public" && (
                    <option value="profile">My public profile</option>
                  )}
                  <option value="lounge">A Lounge</option>
                </select>
              </Field>
              {dest === "lounge" && (
                <Field label="Lounge">
                  <select
                    required
                    value={loungeId}
                    onChange={e => setLoungeId(e.target.value)}
                  >
                    <option value="">Choose Lounge</option>
                    {loungesQ.data
                      ?.filter(
                        l =>
                          l.members.includes(user?.id || -1) &&
                          (clip.audience === "public" || l.id === clip.loungeId)
                      )
                      .map(l => (
                        <option value={l.id} key={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
              <p className="small-copy">
                This posts the rendered clip to the selected audience.
              </p>
              <button
                className="btn primary full"
                disabled={
                  busy || transcriptionBusy || (dest === "lounge" && !loungeId)
                }
                onClick={publishClip}
              >
                {busy ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Share2 size={16} />
                )}
                Confirm & publish
              </button>
            </div>
          )}
        </aside>
      </div>
      <div className="editor-footer">
        <span>
          Private draft{" "}
          <span className="tiny">
            {" "}
            / {seconds(duration)} / {crop.toUpperCase()}
          </span>
        </span>
        <div>
          <button
            className="btn"
            onClick={save}
            disabled={busy || transcriptionBusy}
          >
            <Save size={16} />
            {busy ? "Processing…" : "Save privately"}
          </button>
          <button
            className="btn primary"
            onClick={() => setPublish(!publish)}
            disabled={busy || transcriptionBusy || clip.status === "bookmarked"}
          >
            <Share2 size={16} />
            Publish clip
          </button>
        </div>
      </div>
      {transcribeConfirm && (
        <Confirm
          title="Generate captions for this clip?"
          description="This saves the current edit and sends this clip’s audio to the speech service. Usage may consume your app’s credits. Existing captions will be replaced with an editable transcription; nothing will be published."
          label="Confirm & generate"
          onClose={() => setTranscribeConfirm(false)}
          onConfirm={async () => {
            const saved = await save();
            if (!saved)
              throw new Error(
                "Save your clip successfully before generating captions."
              );
            let ready = saved;
            const deadline = Date.now() + 180000;
            while (ready.status !== "ready" && Date.now() < deadline) {
              if (ready.status === "error")
                throw new Error(ready.error || "Clip rendering failed.");
              await new Promise(resolve => setTimeout(resolve, 1800));
              ready = await api<Clip>(`/clips/${clip.id}`);
            }
            if (ready.status !== "ready")
              throw new Error(
                "Rendering is still running. Try caption generation when the clip is ready."
              );
            await post(`/clips/${clip.id}/transcribe`, { confirmed: true });
            setAwaitingCaptions(true);
            await refresh();
            toast.info(
              "Generating captions from your real clip audio. Review them here when ready."
            );
          }}
        />
      )}
    </Modal>
  );
}
