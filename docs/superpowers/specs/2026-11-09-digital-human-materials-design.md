# AI营销素材与 ZEGO 数字人

## Intent and confirmed requirements

The user requests AI营销素材生成 → AI营销素材, removal of 产品演示稿, a unified 图文生成 entrance for existing image/video workflows, and a 数字人 surface accepting a photo or video and configuring an avatar for live broadcasting. They explicitly chose third-party platforms such as 抖音 via a push URL. Keep the existing `materials` route and the current Site, audience, account isolation and APIMart results.

## Approaches and provider facts

Use separate APIMart generation and ZEGO reusable-avatar/live modules behind two top-level tabs. Extending the APIMart image/video kind ternaries to a third provider is unsuitable: avatars have uploaded source assets and long-lived live sessions. Browser-only mock generation is unsuitable because it cannot produce a vendor avatar or live stream. Use server-side signed ZEGO REST, existing encrypted connection storage, independent D1 records and private R2 uploads. No new dependency is needed.

This is the implementer's architecture choice within the user's explicit feature request. The user confirmed ZEGO is not yet enabled and explicitly asked to connect the flow and configuration first. No paid live/training verification or service entitlement is assumed.

Verified official sources (2026-11-09):

- [Overview](https://doc-zh.zego.im/aigc-digital-human-server/introduction/overview): photo and recorded-video customization are separate from realtime driving.
- [Production platform](https://doc-zh.zego.im/aigc-digital-human-server/digital-human-customization/avatar-production-platform): platform/offline customization; current public docs provide no photo/video training HTTP contract or production-platform deep link. Do not invent a training endpoint, task or progress.
- [List](https://doc-zh.zego.im/aigc-digital-human-server/streaming-apis/digital-human-management/get-digital-human-list) and [info](https://doc-zh.zego.im/aigc-digital-human-server/streaming-apis/digital-human-management/get-digital-human-info): `aigc-digitalhuman-api.zegotech.cn`, GetDigitalHumanList/GetDigitalHumanInfo.
- [Signing](https://doc-zh.zego.im/aiagent-server/api-reference/accessing-server-apis): `SignatureVersion=2.0`, MD5(AppId + SignatureNonce + ServerSecret + Timestamp), fresh 8-byte hex nonce, seconds timestamp. Secrets remain server-side.
- [Create live instance](https://doc-zh.zego.im/aiagent-server/api-reference/agent-instance-management/create-live-digital-human-agent-instance): `aigc-aiagent-api.zegotech.cn`, CreateLiveDigitalHumanAgentInstance with registered AgentId, DigitalHuman.DigitalHumanId, ConfigId web, EncodeCode H264, AlphaMode 1, `CDN:{Url}`, `AdvancedConfig:{MaxIdleTime:120}`. Existing registered agent supplies its TTS configuration; absent TTS/agent entitlement is reported, never synthesized. No RTC join or external SDK is needed for CDN output.
- SendAgentInstanceTTS: Text <=300 characters, `AddHistory:false`, `Priority:Medium`, `SamePriorityOption:Enqueue`. QueryAgentInstanceStatus reports IDLE/LISTENING/THINKING/SPEAKING. DeleteAgentInstance stops the known instance. Provider success means instance accepted, not third-party platform delivery verification.

## User flows

1. 图文生成: image initially selected; compact 输出类型 image/video selector, separate drafts and histories, existing idempotency, private results and bounded poll/retry behavior. Remove PPT controls/editor/export; retain historical storage compatibility without destructive deletion.
2. 数字人: upload/drop one PNG/JPEG photo (<=20MiB) or MP4 video (<=100MiB). These are application storage limits, not falsely attributed ZEGO training limits. Show local preview, filename and progress. An uploaded source becomes `awaiting_customization` and offers authenticated download plus the ZEGO production instructions. Explicitly explain customization is completed through ZEGO's enabled platform/service. No provider-accessible source URL is fabricated: this private Site's outer SSO prevents external fetch even with a query token.
3. After ZEGO customization, enter the returned DigitalHumanId and verify it with GetDigitalHumanInfo before changing the source to ready. Support adding an existing ZEGO avatar by ID without uploading another source, also verified server-side. Do not expose all workspace-private vendor models to every sales account. A read-only catalog request can return public models (FetchMode2, <=20/page) only; own linked private avatars stay member-scoped.
4. Select a ready avatar, enter live name/platform and RTMP/RTMPS push URL; save configuration without starting anything. The complete push URL/key is encrypted at rest and never returned; an empty password field retains it, a safe protocol/host-only display indicates it is saved. Do not fetch user push URLs from the application server.
5. Start push explicitly, show provider instance/state, send a <=300-character script explicitly, refresh state, and stop explicitly. Creation timeout becomes `start_unknown` and cannot automatically create another instance. Status error never claims a running instance has stopped. Set bounded idle shutdown120s. UI explains the target platform must accept the provided push URL and actual picture should be checked there. No claim of 抖音 certification or platform-specific login integration.

## Security and durability

- Owner identity and member ID come only from trusted middleware. Business assets/live/commands are scoped to owner+member for both managers and sales; admin maintains ZEGO connection only. Add explicit member-policy routes/methods. Preserve legacy identity/auth and Site audience.
- Use `workbench_api_connections` kind `zego_digital_human`, immutable official hosts; metadata stores AppId+registered AgentId, ciphertext stores ServerSecret. Blank retains key. Admin test calls readonly GetDigitalHumanList only, never training/create-live/TTS. Public connection projection has flags and version only (admin metadata also has AppId/AgentId).
- Source upload uses JSON reservation then raw PUT to a known asset ID, bounded streaming/multipart, signature validation and MIME consistency. Never buffer 100MiB video in the Worker or use request.formData for it. Distinct per-attempt object keys, CAS and upload lease prevent old attempts committing over a new upload; clean only that attempt's partial object. Source fetch supports private GET/HEAD/range for video, no external source token or public bucket.
- D1 source records and live records use request identity, immutable request payload hash, CAS version; live start/stop reserve before network I/O. Duplicate live start returns the same intent; an ambiguous submission never silently retries creation. Journal TTS commands by requestId to prevent duplicate charge/utterance after response loss. Existing source/assets are never removed as QA.
- No secrets, push keys, signed request URLs, raw provider bodies or R2 keys in browser/error projections. Provider errors return bounded action + numeric error code/request ID when available, with generic text.
- Use existing CSS tokens, single-line input/select heights36px desktop/44px mobile, no decorative left accent bars. Top tabs retain drafts and pause readonly polling while hidden; aggregate busy/dirty to existing Workbench leave guards. Cleanup never starts/stops an external session.

## Contract between UI and backend

Names below are authoritative; implementer may split internal modules, but coordinate any interface change first.

`GET /api/digital-humans` returns `{assets:DigitalHumanAsset[],lives:DigitalHumanLive[],connection:DigitalHumanAvailability}`.

`DigitalHumanAsset`: `{id,requestId,version,name,sourceKind:'photo'|'video'|'existing',status:'uploading'|'upload_failed'|'awaiting_customization'|'ready',fileName?,mime?,size?,sourceUrl?,digitalHumanId?,digitalHumanName?,createdAt,updatedAt,error?}`. SourceUrl is authenticated same-origin `/api/digital-humans/source?assetId=...`, absent until source is committed. Do not return provider preview URLs or render untrusted remote media. UI can use uploaded source as ready-avatar preview; existing-avatar record displays a neutral avatar icon/name.

`DigitalHumanLive`: `{id,requestId,version,assetId,name,platform,hasPushUrl,pushUrlDisplay,status:'draft'|'starting'|'start_unknown'|'running'|'stopping'|'stop_unknown'|'stopped'|'error',generationId?:string,providerState?:'IDLE'|'LISTENING'|'THINKING'|'SPEAKING',hasInstance:boolean,lastCommand?:{requestId,status:'sending'|'accepted'|'unknown'|'failed',text,createdAt},createdAt,updatedAt,error?}`. generationId is the stable local start intent ID, distinct from the vendor instance ID; speech identity and polling budgets use it to distinguish confirmed stop/restart cycles. No push URL/ciphertext/provider credentials or instance configuration object in projection. Optional provider instance ID is not required by UI; server uses saved instance only.

`DigitalHumanAvailability`: `{configured,enabled,storageReady,liveReady,customizationMode:'zego_platform'}`.

`POST /api/digital-humans` accepts:

- `{action:'createAsset',requestId,name,sourceKind:'photo'|'video',fileName,mime,size}` → `{asset}` reservation. Existing same identity/metadata returns same asset.
- `{action:'bindAvatar',assetId,version,digitalHumanId}` → `{asset}`; requires committed upload and provider info verification.
- `{action:'addAvatar',requestId,name,digitalHumanId}` → `{asset}` existing-avatar intent, provider info verification before ready.
- `{action:'saveLive',requestId,liveId?,version?,assetId,name,platform,pushUrl?:string}` → `{live}`. Empty/omitted pushUrl retains an existing secret; new live requires URL. Only ready own asset. No external call.
- `{action:'startLive'|'refreshLive'|'stopLive',liveId,version,requestId}` → `{live}`. Start request identity stable across ambiguous retry; no implicit restart.
- `{action:'speak',liveId,version,requestId,text}` → `{live}` with journaled lastCommand. No silent retry.
- Optional `{action:'publicAvatars',offset}` → `{avatars:[{digitalHumanId,name}],total,offset}` readonly; no private-model list exposed.

`PUT /api/digital-humans/source?assetId=...&version=...` raw file bytes with Content-Type matching reservation → `{asset}`. Browser retries first GET the list and reuse same reservation; response loss after successful upload must not create duplicate assets. If upload still in progress lease, server409; complete awaiting_customization/ready is returned idempotently. GET/HEAD same route return only current member's saved source.

`GET /api/zego-connection` → `{connection:{...availability,appId,agentId,hasSecret,version}}`; `POST` `{action:'save'|'test',version,appId,agentId,secret,enabled}` → `{connection,message}`. Default disabled/unconfigured. No production connection writes during QA without user's chosen real credentials.

## Verification and release

Real SQLite tests for identity/CAS/member isolation/encrypted config/push URL, signing fixtures, unknown live/TTS results, stop/query errors, upload signatures/limits/concurrent streams. Actual React browser tests for new navigation/noPPT, image/video regressions, upload/drop/response-loss retry, honest customization states, ready-avatar/live config, no implicit paid calls, busy/dirty aggregation, hidden/unmount polling, desktop/mobile fit and control heights. Run one final frozen full suite plus typecheck/tokens/lint/build, independent focused review and one fix wave. Sync exact private GitHub/Sites source trees and publish preserving audience. Live QA must not start paid training or broadcast to real push URLs; explicitly report absent entitlement/credentials or untested real stream. Earlier original APIMart image was already recovered on v65 with one private PNG and unchanged task ID.

## Builder check amendments

The builder check identified three lifecycle/security requirements and one expiry case; they are part of this spec, not deferred work.

- Vendor AppID access does not prove per-member private-avatar authorization. Public avatars (`IsPublic:true`) can be linked freely; private avatars require an administrator grant `{digitalHumanId,memberId}` in connection metadata. Only administrator GET/POST exposes/changes `avatarGrants`; business routes filter to current member's grants. Internal asset records pin ZEGO AppId. Changing shared AppId cannot silently reuse a private ID from an old application. Connection contract adds `avatarGrants:Array<{digitalHumanId:string,memberId:string}>` (default empty); root admin UI selects a real member account. Every bind/add/start rechecks effective grant/current AppId. Existing `sourceUrl` and files remain private even for public model IDs.
- Live creation pins an encrypted immutable credential snapshot/AppId/AgentId for that instance. Cleanup and status use the pinned snapshot after global connection rotation/disable/AppId changes; new start/bind use current enabled connection. An authenticated owner/member can stop its running instance while global connection is disabled. Never return this snapshot or use current different AppId to infer old instance missing.
- Starting/stopping/TTS states have an explicit transition matrix. Do not edit/restart/replace during pending external mutation; readonly refresh returns an unchanged pending record. Persist known external instance creation success in the durable operation journal before applying projection. A late success is never discarded merely because its live row CAS is stale: guarded journal reconciliation or compensation must retain/stop the known instance. Identical intent retries read the journal; unknown create never submits another creation.
- A local120s clock does not establish terminal status. QueryAgentInstanceStatus's authoritative `410001002` means the instance no longer exists, only when queried with its pinned credentials. Generic provider errors/credential errors preserve known running/unknown state with an error. Provider absence can be reconciled to stopped and clear active controls. Tests cover expiry/missing versus generic errors.

## Consolidated review corrections

- An unconfirmed final source write plus an unavailable verification read must retain its potentially committed R2 object. Cleanup requires authoritative evidence that the object is not the committed source; same-reservation reconciliation remains possible after DB recovery.
- Operation reservation proofs include owner, member, liveId, action and payload hash, not requestId alone. A conflicting request ID on another live row must leave that loser row unchanged after409.
- Browser list responses merge per-record versions and retain newer local mutations/new records. Intent bookkeeping cannot be changed from a stale list. Account changes unmount the entire keyed workbench.
- A new live generation clears current speech status, retains historical operations and gives same-text speech a new per-generation identity. Within-generation response-loss retries remain idempotent. The new generation is visible after a lost start response followed by GET recovery.
- Ready existing-avatar records can be revalidated/rebound without source bytes under the same grant/AppId/CAS/active-live guards. Uploaded photo/video records continue to require a committed source.
