# Respawn Lounge

A real responsive React/Express application for phones, tablets and PC/Mac browsers, with installable PWA support. New communities start empty: there are no seeded members, streams, squads or clips.

## Running

Use Node 22 and the pinned pnpm 10.18.0. Install FFmpeg/ffprobe and DejaVu/Noto fonts for rendered captions. Run `pnpm install --frozen-lockfile`, `pnpm db:migrate`, then `pnpm dev`. Production uses the checked-in Dockerfile or `pnpm build && pnpm start`. The listener honors `PORT` (default 3000). `pnpm check` checks TypeScript; `pnpm test` runs focused media, permission, community, provider-contract and Sidekick tests.

Runtime environment is injected securely by the managed project; credentials are never committed. Required managed values: DATABASE_URL, MANUS_PROJECT_ID, MANUS_JWT_SECRET, MANUS_OAUTH_PORTAL_URL, MANUS_OAUTH_API_URL, MANUS_API_URL, MANUS_API_KEY. The application preserves the `webdev_app_session` cookie and validates HS256 JWT expiry/project identity. OAuth state uses a browser-bound one-time nonce.

## Actual media workflow

Sign in, create a Lounge if desired, and upload an MP4/MOV/WebM (100 MiB max, 30-minute duration cap). Studio sets source audience and creator clipping/publication/download permissions. The source is persisted to object storage, normalized by FFmpeg and given a poster. Watch the source and tap Clip That or press C. Capture uses the actual viewed source currentTime, preceding 15/30/60 seconds, and clamps at zero without interrupting playback.

The tray holds private drafts. Editor trims up to 60 seconds, loops the selected source interval, repositions original/9:16/1:1 crop, edits timed captions and overlay, and queues a real playable MP4 render. Publishing explicitly confirms the destination and waits for a ready render. Source attribution is immutable. Watch Original seeks to the clip's original source start. Private-Lounge source clips cannot be published outside that Lounge. Every metadata, media, poster, download and transcript request checks source/clip permissions server-side. Byte ranges are capped at 8 MiB; downloads are assembled client-side. Storage addresses are never returned in app metadata. Resource-scoped short-lived media tickets support Preview bearer-only sessions and continue to recheck membership.

Media jobs and state are persisted in managed MySQL with row locks, bounded queue, two globally leased processing slots, heartbeat/timeout/crash recovery. Undo immediately soft-deletes application visibility; the runtime storage API does not promise physical object erasure.

## Sidekick

Sidekick uses actual available transcripts/chat, real squad listings and actual Studio settings. Simple clip commands use the same permission-checked clipping function without AI. Vertical captioned drafts preserve correction before public posting. Push-to-talk records only after microphone permission and shows recording state, transcribes using the actual speech API, then lets users review text before sending. Saved gaming personalization is opt-in and can be cleared. Publication, sending messages and joining a squad use explicit user confirmation; AI cannot start broadcasts or spend money. Requested data not yet available is identified honestly.

## Live streaming is intentionally disconnected

The owner selected “Build the rest and leave live-provider connection disabled for now.” Live broadcast is disabled until a real provider is connected. The supported Cloudflare Stream integration requires securely declared RESPAWN_CF_TOKEN (Account Stream Edit) and RESPAWN_CF_ACCOUNT_ID, and Stream usage is paid. No live resources or broadcasts are created by default. Provider integration uses actual input/status/replay APIs, signed HLS and private application access checks. Sliding live playheads whose recording mapping is not verified remain labeled Moment bookmarked rather than incorrectly captured; footage may become playable after replay readiness. Real delayed-live verification requires a broadcaster and configured provider.

## Cross-platform scope

Use a current Chrome/Edge/Firefox/Safari browser. Install through the browser's Install app or Add to Home Screen option on supported phones and desktop. The PWA caches only a public offline page and icon—never private API responses or media. Native App Store/Play Store binaries are separate deliverables.

Hosting, storage, video processing and AI may have operating costs. Building a working application is not a claim of unlimited free infrastructure or completed external live-broadcast verification.
