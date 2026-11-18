# Shared backend contract

Shared frontend types in shared/app-types.ts. REST endpoints are relative and return JSON. Errors {error:string}, appropriate status. Protected OAuth identity via sdk.authenticateRequest(req); public reads allow anonymous with audience filtering. Never fake users/data.

## Persistence helper to be implemented by media agent

server/features/store.ts: generic durable appRecords table (id string primary key, kind string, ownerId int, payload JSON, revision int, updatedAt). Export `list<T>(kind:string): Promise<T[]>`, `get<T>(kind:string,id:string): Promise<T|undefined>`, `create<T extends {id:string}>(kind:string,ownerId:number,data:T): Promise<T>`, `mutate<T>(kind:string,id:string,fn:(value:T)=>T): Promise<T>` using transaction row locks, `remove(kind,id):Promise<void>`. Domain object lives entirely in payload. store creation unique IDs caller uses crypto.randomUUID. OAuth users table retained. Source internal fields objectKey/posterKey and Clip outputKey/posterKey MUST NOT leak client JSON.

server/features/access.ts exports `optionalUser(req):Promise<User|null>`, `needUser(req):Promise<User>`, `canReadSource(source,userId?):Promise<boolean>`, `canReadClip(clip,userId?):Promise<boolean>`, `canClipSource(source,userId:number):Promise<boolean>`, `publicSource(source):Source`, `publicClip(clip):Clip`; serializers supply permission checked /api/media URLs and remove internal keys. Export `route(fn)` Express async wrapper consistent errors. All state-changing REST paths require same-origin check with Origin/Sec-Fetch-Site, no permissive CORS. sdk keeps validated real auth.

## Media agent routes via registerMediaRoutes(app)

GET /api/app/sources (accessible ready/live sources, optional loungeId)
GET /api/app/sources/:id accessible source
POST /api/app/upload multipart file (100 MiB cap), title, game, audience public/lounge, loungeId, allowClip everyone/members/creator, allowPublish true/false, allowDownload true/false. Validate identity/audience membership before accepting bytes. Real FFmpeg/ffprobe extraction and durable original/poster storage. Return Source, asynchronous processing.
PATCH /api/app/sources/:id owner only title/audience/permissions.
GET /api/app/clips?scope=tray|feed&loungeId=...; tray protected owner; feed accessible published.
GET /api/app/clips/:id owner/private or accessible published.
POST /api/app/clips {sourceId,position,duration:15|30|60}, uses source-relative position, validates access and permission; queues real render or honest live bookmark.
PATCH /api/app/clips/:id owner-only editable title/start/end/crop/cropX/cropY/captions/overlay, clamped finite input; preserves immutable source/audience/credit. Queue re-render.
POST /api/app/clips/:id/publish {destination:profile|lounge,loungeId?,confirmed:true}. Requires ready, creator publish permission, original access, Lounge membership. Private source can ONLY publish in original Lounge. Explicit confirmation.
DELETE /api/app/clips/:id owner only Undo/soft deletion.
GET /api/media/source/:id, /clip/:id, /poster/source/:id, /poster/clip/:id, /download/:id; never redirect/expose storage signed URL/key. Auth checked on every range request, proxied bytes bounded ranges. Downloads enforce creator permission. File privacy never reduced. Optional API media ticket for Preview bearer-only users: short-lived signed resource/user-scoped token, always recheck user/access; frontend can use URL supplied by serializers only when authenticated.
POST /api/app/sources/:id/transcribe actual API transcription, persisted Caption[].
POST /api/app/voice raw/form audio through transcription, max 10MiB.
GET /api/app/services ServiceState real env/probe availability.
GET/POST /api/app/chat?sourceId=... (POST sourceId,text,position,confirmed:true) accessible source, persisted actual messages. Clip POST/PATCH helper exported `createClip(user,body)` and `updateClip(user,id,body)` for Sidekick to call with actual permission checks.

## Community agent routes via registerCommunityRoutes(app)

GET /api/app/lounges accessible public or member/owner private; don't expose private membership requests to outsiders. POST name/description/game/privacy creates owner membership.
POST /api/app/lounges/:id/join {confirmed:true} create request; POST /.../approve {userId,confirmed:true} owner only. Membership arrays updated atomically.
GET /api/app/squads only unexpired open (owner also gets own); POST title/game/platform/mic/startsAt/expiresAt/capacity/vibe. POST /:id/join {confirmed:true} checks live capacity/expiry atomically; owner approves /:id/approve {userId,confirmed:true}.
GET/PATCH /api/app/settings actual Preferences; personalization opt-in only. DELETE saved personalization resets saved games/platform/mic/availability/name/avatar/tone/accent but preserves operational clipDuration/enabled if sensible.
GET/PATCH /api/app/studio actual StudioSettings; real provider status; POST /api/app/studio/connect {confirmed:true} Cloudflare live input creation (NO broadcast start, returns actual OBS secrets owner-only). Live provider module server/features/live.ts community agent owns it. No secrets client except owner's explicit stream key.
Cloudflare uses RESPAWN_CF_TOKEN + RESPAWN_CF_ACCOUNT_ID (securely configured). Stream input record status/replay actual API. Media agent may import helpers from live.ts `getLiveReplay(source):Promise<{url:string;duration:number}|null>` and `getLivePlayback(source):Promise<string|null>`; coordinate with research notes /home/ubuntu/live-research.md. No simulated connection. Cloudflare missing env returns 503 descriptive.

## Sidekick agent routes via registerSidekickRoutes(app)

POST /api/sidekick {message,sourceId?,clipId?,position?}. Returns SidekickResult. Need OAuth, access to source/clip/context, opt-out respected. Local clip command calls createClip same duration even AI offline. Vertical action calls updateClip with crop=vertical and source transcript relative captions, renders draft; optional real AI title. Laugh search only actual available transcripts audio annotations; return plausible timestamps. Recap accessible actual last few minutes transcript/chat and links, chat-only label. Squad matching current real records against preferences. Studio reads owner's settings and actual service status. Free chat actual AI gpt-5.5 if live catalog supports (choose non-deprecated based on catalog /home/ubuntu/llm-catalog.json and web models). AI cannot publish/send/start/spend automatically; returns requiresConfirmation + proposed action. Never claim unavailable data exists. Request rate/timeout limits.

Main agent integrates registration in server/_core/index.ts, frontend, PWA, Docker/dependencies and diagnostics. Agents DO NOT edit index.ts, routers.ts, package.json/lock, UI or same files as others. Media owns schema/migrations/store/access/media/processing. Community owns community/live. Sidekick owns sidekick. Each runs focused tests and reports limitations. No git commits or seeded fake data. Follow plan.md and TODO.md.
