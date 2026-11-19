# Respawn Lounge validation

## Confirmed

The TypeScript check and production build pass. On 2026-11-18 at 22:01 UTC, 126 tests passed across 10 files. Evidence includes real scratch FFmpeg original/vertical/square rendering with timed captions/overlay/posters; mock-provider actual FFmpeg extraction, transcription-result handling and subsequent captioned render; server ACL/private-outsider/confirmation checks; durable job lease/crash bounds; actual bounded HTTP Range transfer; community membership, full/expired squads and provider contract behavior; Sidekick access/evidence/customization/confirmation gates; source-time conversion, caption trimming and timezone-safe scheduling; OAuth JWT project binding.

A real durable-storage smoke test uploaded a tiny non-user diagnostic text object, fetched it through the real signed retrieval service and verified exact byte equality. No user/application records were created. The runtime storage API has no deletion method; the diagnostic object is a small retained health-check object, not a user asset.

The running health endpoint returns success, the route manifest matches registered pages including private-Lounge invitation routing, and source/Lounge lists return real empty arrays. The service endpoint reports AI/transcription/media processing configured and live=false. This is configuration/service-probe evidence, not a guarantee that every provider action has passed acceptance. Three actual Sidekick AI calls succeeded through the project service during development; optional title/draft errors never invent success.

Browser navigation confirmed the app's logged-out discovery state and actual OAuth authorization portal. A read-only implementation review identified and led to fixes for ticket-driven playback interruption, private invitation wiring, source-relative Sidekick/chat positions, same-page timestamp seek, chunked authenticated downloads, actual transcription controls, Sidekick identity consent, trimmed-caption validity, timezone scheduling and identity-partitioned cache/logout cleanup.

## Not yet verified

The real browser remains at the account sign-in screen. No simulated Preview identity, forged session or test member was inserted into production. Actual signed-in browser upload → durable processing → playback → uninterrupted one-tap clip → editor trim/crop/captions → render → confirmed Lounge publication → second-account playback/Watch Original remains to be executed with real accounts. Private invite/request/approval and outsider copied-link denial are covered by focused server tests, not a completed two-account browser acceptance run. Installed phone/PC behavior and real paid speech-provider transcription have not been exercised; mocked service tests are distinguished above.

The owner explicitly deferred live-provider connection. No live broadcast, delayed-live mapping or private live-provider acceptance is claimed. Native iOS/Android App Store/Play Store packages are not part of the responsive installable web-app build. Publication is separate from a saved checkpoint or GitHub pull request.

## Final targeted changes

Confirmed clip-caption generation is wired in the editor, source transcription in the player, private invitations through /invite/:id, and invitation context survives OAuth. Both speech requests require explicit confirmation. Final full suite: 126 passed; typecheck/build passed at 22:10 UTC.
