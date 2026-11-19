import { useEffect, useId, useRef, useState } from "react";
import { Search, Smile, X } from "lucide-react";
import "./social.css";

export const EMOJI_CATALOG = [
  ["🎮", "Game controller", "Gaming"],
  ["🕹️", "Arcade joystick", "Gaming"],
  ["👾", "Alien monster", "Gaming"],
  ["🎯", "Bullseye target", "Gaming"],
  ["🏆", "Trophy winner", "Gaming"],
  ["🥇", "Gold medal", "Gaming"],
  ["⚔️", "Crossed swords", "Gaming"],
  ["🛡️", "Shield", "Gaming"],
  ["🎧", "Headphones", "Gaming"],
  ["🎬", "Creator movie", "Gaming"],
  ["📹", "Video camera streamer", "Gaming"],
  ["🎙️", "Microphone podcast", "Gaming"],
  ["💻", "Laptop computer", "Gaming"],
  ["⌨️", "Keyboard", "Gaming"],
  ["🖱️", "Computer mouse", "Gaming"],
  ["🎲", "Dice tabletop", "Gaming"],
  ["😀", "Grinning happy smile", "Faces"],
  ["😂", "Laughing tears", "Faces"],
  ["🤣", "Rolling laughing", "Faces"],
  ["🥹", "Holding back tears", "Faces"],
  ["😍", "Heart eyes love", "Faces"],
  ["😎", "Sunglasses cool", "Faces"],
  ["🤯", "Mind blown", "Faces"],
  ["😮", "Surprised wow", "Faces"],
  ["😭", "Crying", "Faces"],
  ["😤", "Determined frustrated", "Faces"],
  ["🤔", "Thinking", "Faces"],
  ["🤗", "Hug", "Faces"],
  ["🥳", "Party celebrating", "Faces"],
  ["😴", "Sleeping", "Faces"],
  ["🫡", "Salute respect", "Faces"],
  ["🤖", "Robot", "Faces"],
  ["🔥", "Fire hype", "Vibes"],
  ["⚡", "Lightning bolt energy", "Vibes"],
  ["✨", "Sparkles", "Vibes"],
  ["💯", "Hundred perfect", "Vibes"],
  ["🚀", "Rocket launch", "Vibes"],
  ["💎", "Diamond", "Vibes"],
  ["👑", "Crown", "Vibes"],
  ["⭐", "Star", "Vibes"],
  ["🌙", "Moon night", "Vibes"],
  ["🌈", "Rainbow", "Vibes"],
  ["❤️", "Red heart love", "Vibes"],
  ["💜", "Purple heart", "Vibes"],
  ["🩵", "Cyan heart", "Vibes"],
  ["💚", "Green heart", "Vibes"],
  ["👏", "Clapping applause", "Vibes"],
  ["🙌", "Raised hands celebration", "Vibes"],
  ["🤝", "Handshake team", "Vibes"],
  ["👍", "Thumbs up good", "Vibes"],
  ["✌️", "Peace victory", "Vibes"],
  ["💪", "Strong flex", "Vibes"],
  ["👻", "Ghost", "Avatars"],
  ["🐉", "Dragon", "Avatars"],
  ["🦊", "Fox", "Avatars"],
  ["🐱", "Cat", "Avatars"],
  ["🐼", "Panda", "Avatars"],
  ["🦁", "Lion", "Avatars"],
  ["🐺", "Wolf", "Avatars"],
  ["🦄", "Unicorn", "Avatars"],
  ["🐙", "Octopus", "Avatars"],
  ["🦈", "Shark", "Avatars"],
  ["🦇", "Bat", "Avatars"],
  ["🦉", "Owl", "Avatars"],
  ["🐸", "Frog", "Avatars"],
  ["🛸", "UFO spaceship", "Avatars"],
  ["🍄", "Mushroom", "Avatars"],
  ["💀", "Skull", "Avatars"],
] as const;

export function EmojiPicker({
  onSelect,
  label = "Add emoji",
  disabled = false,
}: {
  onSelect: (emoji: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("All");
  const id = useId(),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const choices = EMOJI_CATALOG.filter(
    ([emoji, name, group]) =>
      (category === "All" || group === category) &&
      `${emoji} ${name}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase())
  );
  return (
    <div
      className="emoji-control"
      ref={root}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="social-button emoji-trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(value => !value)}
      >
        <Smile size={17} />
        {label}
      </button>
      {open && (
        <section id={id} className="emoji-panel" aria-label="Choose an emoji">
          <div className="emoji-panel-head">
            <strong>Pick your expression</strong>
            <button
              type="button"
              className="social-icon"
              aria-label="Close emoji picker"
              onClick={() => setOpen(false)}
            >
              <X size={17} />
            </button>
          </div>
          <label className="emoji-search">
            <Search size={16} />
            <input
              aria-label="Search emojis"
              placeholder="Search emojis…"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
          </label>
          <div className="emoji-categories">
            {["All", "Gaming", "Faces", "Vibes", "Avatars"].map(group => (
              <button
                type="button"
                aria-pressed={category === group}
                key={group}
                onClick={() => setCategory(group)}
              >
                {group}
              </button>
            ))}
          </div>
          <div className="emoji-grid">
            {choices.map(([emoji, name]) => (
              <button
                type="button"
                key={emoji}
                title={name}
                aria-label={name}
                onClick={() => {
                  onSelect(emoji);
                  setOpen(false);
                }}
              >
                {emoji}
              </button>
            ))}
          </div>
          {!choices.length && (
            <p className="social-note">
              No matching emoji. Try “gaming”, “heart” or “ghost”.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
