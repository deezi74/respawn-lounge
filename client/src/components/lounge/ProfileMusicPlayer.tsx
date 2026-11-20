import { useEffect, useId, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Music2,
  Pause,
  Play,
  Volume2,
} from "lucide-react";
import { api, errorMessage } from "@/lib/app-api";
import type {
  ProfileWorld,
  WorldAsset,
  WorldMedia,
} from "@shared/profile-world-types";
import {
  musicTime,
  musicSessionKey,
  playableWorldAudio,
  playlistIndex,
} from "./profile-music-utils";
import "./profile-music.css";

export function ProfileMusicPlayer({
  tracks,
  media,
  ownerId,
  preview = false,
}: {
  tracks: ProfileWorld["music"];
  media: WorldMedia;
  ownerId: number;
  preview?: boolean;
}) {
  return (
    <MusicWorkspace
      key={musicSessionKey(ownerId, tracks.length)}
      tracks={tracks}
      media={media}
      preview={preview}
    />
  );
}
function MusicWorkspace({
  tracks,
  media,
  preview,
}: {
  tracks: ProfileWorld["music"];
  media: WorldMedia;
  preview: boolean;
}) {
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false),
    [current, setCurrent] = useState(0),
    [duration, setDuration] = useState(0),
    [volume, setVolume] = useState(0.6),
    [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null),
    active = useRef(true),
    serial = useRef(0),
    request = useRef<AbortController | null>(null),
    intent = useRef(false),
    loadedId = useRef(""),
    autoNext = useRef(false),
    id = useId();
  const track = tracks[Math.min(index, Math.max(0, tracks.length - 1))];
  const trackId = track?.mediaId || "";
  const latestId = useRef(trackId);
  latestId.current = trackId;
  const source = media[trackId];
  const origin =
    typeof window === "undefined"
      ? "https://invalid.local"
      : window.location.origin;
  const playable = playableWorldAudio(source, trackId, origin);
  useEffect(() => {
    active.current = true;
    const mountedAudio = audio.current;
    return () => {
      active.current = false;
      serial.current++;
      request.current?.abort();
      intent.current = false;
      const node = mountedAudio;
      if (node) {
        node.pause();
        node.removeAttribute("src");
        node.load();
      }
    };
  }, []);
  useEffect(() => {
    if (index >= tracks.length) setIndex(Math.max(0, tracks.length - 1));
  }, [index, tracks.length]);
  useEffect(() => {
    const node = audio.current;
    serial.current++;
    request.current?.abort();
    loadedId.current = "";
    setCurrent(0);
    setDuration(source?.duration || 0);
    setError(null);
    setPlaying(false);
    setBusy(false);
    if (node) {
      node.pause();
      node.removeAttribute("src");
      node.load();
    }
    if (autoNext.current) {
      autoNext.current = false;
      void play();
    } else intent.current = false;
  }, [trackId]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume]);
  useEffect(() => {
    if (!playable && audio.current) {
      intent.current = false;
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      setPlaying(false);
    }
  }, [!!playable]);
  async function play(recover = false) {
    const node = audio.current;
    if (!node || !track || !playable) return;
    if (busy && !recover) return;
    const token = ++serial.current,
      expected = trackId,
      position = recover ? current : node.currentTime;
    intent.current = true;
    setBusy(true);
    setError(null);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      if (
        recover ||
        loadedId.current !== expected ||
        !node.getAttribute("src") ||
        node.error
      ) {
        const asset = await api<WorldAsset>(
          `/profile/world/media/${encodeURIComponent(expected)}`,
          { signal: controller.signal }
        );
        const url = playableWorldAudio(asset, expected, origin);
        if (!url) throw new Error("This track is no longer available.");
        if (
          !active.current ||
          serial.current !== token ||
          latestId.current !== expected ||
          !intent.current
        )
          return;
        loadedId.current = expected;
        node.src = url;
        node.load();
        if (position > 0) {
          const seek = () => {
            if (latestId.current === expected && Number.isFinite(node.duration))
              node.currentTime = Math.min(
                position,
                Math.max(0, node.duration - 0.1)
              );
          };
          node.addEventListener("loadedmetadata", seek, { once: true });
        }
      }
      if (
        !active.current ||
        serial.current !== token ||
        latestId.current !== expected ||
        !intent.current
      )
        return;
      node.volume = volume;
      await node.play();
      if (
        !active.current ||
        serial.current !== token ||
        latestId.current !== expected ||
        !intent.current
      )
        node.pause();
    } catch (cause) {
      if (active.current && serial.current === token) {
        intent.current = false;
        setPlaying(false);
        setError(errorMessage(cause));
      }
    } finally {
      if (active.current && serial.current === token) setBusy(false);
    }
  }
  function pause() {
    intent.current = false;
    serial.current++;
    request.current?.abort();
    audio.current?.pause();
    setPlaying(false);
    setBusy(false);
  }
  function select(next: number) {
    if (next === index) return;
    autoNext.current = playing;
    intent.current = false;
    audio.current?.pause();
    serial.current++;
    request.current?.abort();
    setIndex(next);
  }
  function ended() {
    if (tracks.length > 1) {
      autoNext.current = true;
      setIndex(playlistIndex(index, 1, tracks.length));
    } else pause();
  }
  const total = duration || source?.duration || 0;
  if (!tracks.length)
    return (
      <div className="profile-music-empty">
        <Music2 size={25} />
        <p>
          No tracks selected. Add music you own or have permission to share in
          the profile editor.
        </p>
      </div>
    );
  return (
    <div className={`profile-music-player${playing ? " is-playing" : ""}`}>
      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={ended}
        onTimeUpdate={() => setCurrent(audio.current?.currentTime || 0)}
        onLoadedMetadata={() => {
          const n = audio.current?.duration;
          setDuration(n && Number.isFinite(n) ? n : source?.duration || 0);
        }}
        onWaiting={() => setBusy(true)}
        onPlaying={() => {
          setBusy(false);
          setPlaying(true);
        }}
        onError={() => {
          intent.current = false;
          setBusy(false);
          setPlaying(false);
          loadedId.current = "";
          setError(
            "This track could not load. Press Play to renew access and try again."
          );
        }}
      />
      <div className="profile-music-now">
        <div className="profile-music-disc" aria-hidden="true">
          <Music2 size={24} />
        </div>
        <div>
          <span>{preview ? "DRAFT PLAYLIST" : "PROFILE SOUNDTRACK"}</span>
          <strong>{track?.title || "Untitled track"}</strong>
          <small>{track?.artist || "Artist not specified"}</small>
        </div>
        <div className="profile-music-equalizer" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <i key={i} style={{ animationDelay: `${i * 0.11}s` }} />
          ))}
        </div>
      </div>
      <div className="profile-music-controls">
        <button
          type="button"
          aria-label="Previous track"
          disabled={tracks.length < 2 || busy}
          onClick={() => select(playlistIndex(index, -1, tracks.length))}
        >
          <ChevronLeft size={19} />
        </button>
        <button
          type="button"
          className="profile-music-play"
          aria-label={playing || busy ? "Pause music" : "Play music"}
          disabled={!playable}
          onClick={() => (playing || busy ? pause() : void play())}
        >
          {busy ? (
            <Loader2 size={20} />
          ) : playing ? (
            <Pause size={20} />
          ) : (
            <Play size={20} />
          )}
        </button>
        <button
          type="button"
          aria-label="Next track"
          disabled={tracks.length < 2 || busy}
          onClick={() => select(playlistIndex(index, 1, tracks.length))}
        >
          <ChevronRight size={19} />
        </button>
        <label className="profile-music-volume">
          <Volume2 size={16} />
          <span className="profile-music-sr">Music volume</span>
          <input
            type="range"
            min="0"
            max="1"
            step=".01"
            value={volume}
            aria-label="Music volume"
            onChange={e => setVolume(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="profile-music-progress">
        <label htmlFor={`${id}-seek`} className="profile-music-sr">
          Seek within track
        </label>
        <input
          id={`${id}-seek`}
          type="range"
          min="0"
          max={Math.max(1, total)}
          step=".1"
          value={Math.min(current, total)}
          disabled={!loadedId.current || total <= 0}
          aria-valuetext={`${musicTime(current)} of ${musicTime(total)}`}
          onChange={e => {
            const next = Number(e.target.value);
            if (audio.current && Number.isFinite(audio.current.duration)) {
              audio.current.currentTime = Math.min(
                next,
                audio.current.duration
              );
              setCurrent(next);
            }
          }}
        />
        <div>
          <span>{musicTime(current)}</span>
          <span>{musicTime(total)}</span>
        </div>
      </div>
      {error && (
        <p className="profile-music-error" role="alert">
          {error}
        </p>
      )}
      {!playable && (
        <p className="profile-music-error" role="status">
          This track is unavailable to this visitor.
        </p>
      )}
      <ol className="profile-music-list">
        {tracks.map((item, i) => (
          <li key={item.mediaId}>
            <button
              type="button"
              aria-current={i === index ? "true" : undefined}
              onClick={() => select(i)}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <strong>{item.title || "Untitled track"}</strong>
                <small>{item.artist || "Artist not specified"}</small>
              </div>
              {i === index && playing ? (
                <Pause size={14} />
              ) : (
                <Music2 size={14} />
              )}
            </button>
          </li>
        ))}
      </ol>
      <p className="profile-music-footnote">
        Press Play to listen. Music never starts automatically.
      </p>
    </div>
  );
}
