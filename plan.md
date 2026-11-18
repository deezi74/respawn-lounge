# Respawn Lounge implementation

Build a new working application, not a prototype. The supplied GitHub repository contains only README.md. Deliver a responsive installable web app for Android/iPhone/tablets/Windows/macOS browsers; app-store-native binaries are not implied by this web build.

## Architecture

Use the initialized React/TypeScript/Vite frontend and Express backend, Manus OAuth application sessions, managed MySQL for persisted records and media jobs, durable object storage for uploaded video and rendered clips, and a bounded FFmpeg processing worker included in the production Docker image. Private media is served only through permission-checked application endpoints; do not return storage keys or directly accessible object URLs to clients. No fake people, streams, squads, transcripts, or success states. Empty states must lead to real creation actions.

The player captures its actual source-relative currentTime, never wall-clock live edge. Uploads/replays produce playable cuts; live provider replay/DVR availability determines whether cuts are ready or genuinely bookmarked for later processing. Cloudflare Stream is the supported broadcast provider; connection and permissions must be checked and credentials securely configured. No paid broadcast begins automatically. External streams remain provider-supported playback/bookmarks where a clipping API is unavailable.

Clipping uses 15/30/60-second member defaults, clamps the previous interval at zero, preserves playback and the source audience, supports Edit and Undo, and persists a private tray. Editor renders real original/9:16/1:1 cropped outputs with repositioning, editable timed captions and optional overlays. Publication is a confirmed action and requires source permission. Watch Original uses the original source start and access checks.

Sidekick has opt-in saved name/avatar/tone/accent/preferences, text and supported push-to-talk, server-side AI and transcription, deterministic offline clip handling, permission-checked actions, transcript search, editable vertical drafts, timestamped recaps, real squad matching and actual studio settings. Unavailable services are identified honestly. Drafts may be prepared immediately; publication/messages/broadcasts/spending require confirmation. No spending tool is implemented.

Community includes public/private Lounges, membership requests and owner approval, published clips and source videos, squads with game/platform/mic/availability/capacity/expiry and confirmed join requests. Studio includes actual upload, creator permission settings, source audience, title/scheduling, connected stream destination and browser mic check. Live connection setup is gated on valid provider configuration, not simulated.

## Project structure

- `client/src/components/lounge/`: shared shell, player, editor, Sidekick and creation/settings dialogs.
- `client/src/pages/`: home/discover, Clip Tray, Lounges, squads, Studio, profile/settings and shared clip routes.
- `shared/app-types.ts`: domain types and API contracts.
- `server/features/`: authorization, persistence, media processing, community/studio and Sidekick routes.
- `drizzle/`: additive managed database schema/migrations.
- `client/public/`: route manifest, install manifest, logo/icons and service worker. No private media caching.
- `server/*.test.ts`: focused permission, interval, processing and tool confirmation tests.

## Design

The user corrected the visual direction: gamer-themed neon colors, not warm paper or pastel surfaces. Keep the working layout and all functionality; replace the visual palette throughout the app.

**Design movement:** Neon arcade lounge with near-black gaming surfaces, electric accent lighting and high-contrast utility chrome.

**Core principles:** Content-first asymmetry; clearly reachable actions; honest operational state; community over vanity metrics.

**Color philosophy:** Midnight black #090B14 and dark indigo panels #121625 make gameplay the focus. Neon cyan #00E5FF leads navigation and action states; electric violet #A855F7 and hot pink #FF3DA6 distinguish Sidekick and community accents; acid lime #B6FF3B highlights capture. Bright neutral text remains readable without glowing body copy. Error/warning colors remain semantic.

**Layout paradigm:** A narrow left navigation rail and spacious editorial content column on desktop, turning into a bottom thumb navigation and single-column flow on phones. Player/tray use adjacent workspace panels where space permits.

**Signature elements:** A neon geometric respawn loop mark, small mono status labels, cyan/violet edge lighting and luminous clipping buttons. Apply the palette to forms, dialogs, editor, Sidekick, settings, mobile navigation, install icons and offline page—not just the discovery banner.

**Interaction:** Immediate reversible capture; explicit public-action confirmation; real progress and error recovery.

**Animation:** 160–220ms opacity/translation transitions, subtle saved confirmation, no autoplaying decorative animation; respect reduced motion.

**Typography:** Space Grotesk for the wordmark/headlines, Inter for controls and reading, monospace for timecodes/status. Large concise headlines and spacious readable form labels.

**Brand essence:** The place gamers keep their moments and find their people. Grounded, playful, capable.

**Brand voice:** Direct and friendly. Examples: “Good moments deserve a replay.” and “Saved. Keep playing.”

**Wordmark:** Lowercase respawn with a custom angular loop mark and compact LOUNGE sublabel.

**Signature color:** Electric cyan #00E5FF, with electric violet and acid-lime supporting accents.

## Material constraints

A new community starts empty. Real broadcast and the delayed-live verification require a configured streaming provider and an actual broadcaster. No credentials, paid accounts, or stream footage have been supplied by the user. Confirm the implementation plan and securely connect available services as needed. Separate building/checkpointing from public publication. Do not claim unexecuted second-account or live-broadcast checks as passed.

## Approved change — live provider deferred

The user explicitly chose “Build the rest and leave live-provider connection disabled for now.” Do not require provider credentials, create paid live resources, or claim live-broadcast tests passed. Keep disconnected availability explicit and supported integration ready for later connection. Complete actual uploaded-video clipping, editor, private community, squads, Sidekick and responsive/installable web experience now.
