# Mock API contract

Every behaviour of the mock and the server code it copies. Source: the `encatch-user` repository, branch `Mil-2026-v2-release-10`.

- **GW** = `user-gateway-service`
- **CA** = `rust/core-api/src`

Each behaviour is covered by `test/contract.test.ts`. When the server changes, update this table, the mock and the test together.

## Gateway

| Behaviour | Mock | Server source |
|---|---|---|
| Routes | `POST /v2/encatch/<name>`, and the SDK's `/engage-product/encatch/api/v2/encatch/<name>` (that prefix is stripped by an ingress outside `encatch-user`). Anything else → 404 `{"error":"route not found"}` | GW `ugw-core/src/config.rs:229-237` |
| API key | `X-Api-Key` header or `?X-Api-Key=`. Missing → 401 `{"error":"api key is required"}`. Unknown key or referer not allowed → 401 `{"error":"invalid api key"}` | GW `ugw-proxy/src/lib.rs:306-423` |
| Referer | Empty → 401 `{"error":"referer is required"}`. A package id is compared case-insensitively; `*` allows any | GW `ugw-proxy/src/lib.rs:331-351`, `ugw-auth/src/referer.rs:7-36` |
| Secure identify | identify-user only, and only when `X-User-Name` is present. A key with a secret needs `X-User-Signature` = hex HMAC-SHA256 of `userName`, or of `userName + X-User-Session-Time` when the key has a session time. The timestamp is epoch ms and expires after the session time in whole minutes. **`X-User-Signature-Time` is not read.** Failures → 401 `{"error":"invalid api key"}` | GW `ugw-auth/src/session.rs:35-160`, `hash.rs:15-19`, `ugw-core/src/headers.rs:10-11` |
| Rate limits, `scopes` model | One shared set of buckets for every endpoint: user (keyed on `X-User-Id`, skipped when absent), IP (`X-Real-Ip`, else first `X-Forwarded-For`, else `127.0.0.1`), project. Fixed window. All buckets are checked before any is incremented, so a rejected request uses no quota | GW `ugw-ratelimit/src/key.rs`, `model.rs`, `encatch_ugw_ratelimit.valkey.lua`, `http_util.rs:55-68` |
| Rate limits, `per-endpoint` model | One bucket per endpoint with its own key (user name, user id, device id or IP). **Not in the gateway code today.** Models the report's description and the planned production limits | Report; decision 7 |
| 429 | `{"error":"rate limit exceeded"}`, `Retry-After` = ceil(ms to window reset / 1000), and `X-RateLimit-Limit` / `-Remaining` / `-Reset` (unix seconds). Successful replies also carry `X-RateLimit-*` | GW `ugw-proxy/src/lib.rs:490-503, 653-655`, `ugw-ratelimit/src/model.rs:341-360` |

### Presets

| Preset | Model | Limits per minute |
|---|---|---|
| `off` | — | none (default) |
| `code-defaults-test` | scopes | user 10, IP 50, project 50 (GW `model.rs` defaults for a test key) |
| `code-defaults-prod` | scopes | user 100, IP 300, project 40000 (GW `model.rs` defaults for a prod key) |
| `report` | per-endpoint | 500 each for identify, track-event, track-screen, ping, show-form, submit-form, by device |
| `per-endpoint-5` | per-endpoint | 5 each, by device (step 0b) |
| `planned-prod` | per-endpoint | identify 5 by **user name**, track-screen 20, track-event 5, show-form 100, submit-form 100 (decision 7) |
| `tiny` | scopes | IP 5 |

## Core API

| Behaviour | Mock | Server source |
|---|---|---|
| Error body | `{status, error, message}` | CA `error.rs:202-264` |
| Required headers | `X-Session-Id` and `X-Device-Id`, else 400 `Missing required header: …` | CA `extractors/headers.rs:186-195` |
| Identity | Except on identify-user: `X-User-Name` and `X-User-Id` both present or both absent, else 401. `X-User-Id` must be a UUID equal to UUIDv5(namespace, `"{org}:{project}:{userName}"`), else 401. Known user = both present | CA `validate_user_identity.rs:40-76`, `services/uuid_generator.rs:41-57` |
| Ping timing | identify-user answers a user not yet in the server's cache (a new user) with `pingAgainIn: 10` (`IDENTIFY_USER_PING_AGAIN_IN_UNCACHED`), a cached user with 30 (`…_CACHED`). While the contact isn't created yet, later requests get `pingAgainIn: 10` and count as failures; after 5 in 5 minutes (`USER_PENDING_FAILURE_THRESHOLD`, `…_TTL_MINUTES`) the reply is `pingAgainIn: 900` (`PING_AGAIN_IN_USER_PENDING_EXHAUSTED`) with `userPendingRetryExhausted: true`. The mock's user-pending mode is off by default | CA `config.rs:440-464`, `services/identify_user.rs:173`, `handlers/encatch.rs:745-775` |
| Survey choice | identify, ping, track-event and track-screen replies can carry `nextFeedbackId` and `onPageDelay`, with `pingAgainIn = 30 + onPageDelay` and `pingOnNextPageVisit: true`. Otherwise `pingAgainIn: 30`. **No reply ever carries `formConfigurationId`.** The server keeps choosing the survey on every reply until the person stops being a candidate | CA `handlers/encatch.rs:92-113` (`apply_display_result!`), `services/display_feedback.rs:76-79`, `models/response.rs` |
| identify-user | Body `userName` required, else 401 `userName not found`. Reply `{message, userId, pingAgainIn, pingOnNextPageVisit, nextFeedbackId?, onPageDelay?}`. The identity rule is skipped | CA `handlers/encatch.rs:237-249, 400-652` |
| track-event | `eventName` 1–100 chars, else 400. Visitors: system events (`form:show`, `form:started`, `form:dismissed`, `form:complete`, `form:answered`) → 403 `{"message":"Event tracking not allowed for visitors"}`; custom events need `allowTrackEventForVisitors`. Disabled event → 400 `Event '<name>' is not allowed to be captured` | CA `handlers/encatch.rs:1674-1921`, `services/track_event.rs:25-31, 172-175, 276-325` |
| track-screen, ping | The screen comes from `$deviceInfo.$urlOrScreenName`. Reply: the shared fields above | CA `handlers/encatch.rs:2311-2406, 3836-3938` |
| show-form | `formSlugOrId` required, else 400. Unknown form → 404 `Form not found: …`. Visitors need `visitorsEnabled`. Automatic shows are 404 `Form not available: User is not eligible for this form` within `autoShowCooldownMs` of the last automatic show to the same person (models the production "1 × 200 then 16 × 404"). The reply passes `@encatch/schema`'s `fetchFeedbackDetailsResponseSchema`, plus `partialResponseEnabled`, which the server always sends but the schema doesn't list | CA `handlers/encatch.rs:3001-3158`, `services/show_form.rs:501-930`, `models/response.rs:347-418` |
| submit-form | `formDetails` and `formDetails.formConfigurationId` required, else 400. 404 not-eligible when the form was dropped from the person's candidates. Reply `{"message":"ok"}` | CA `handlers/encatch.rs:4191-4329`, `services/submit_form.rs:168-172, 408-437` |
| Burst drops the open survey | With `burstDropsOpenForm`, an identify, track-event or track-screen that arrives while a survey is open drops it from that person's candidates, so the submit gets 404 (report section 4) | Report section 4; CA `services/submit_form.rs:408-437` |
| dismiss-form | Visitor → `{"message":"ok"}`. Known user: `formConfigurationId` must be a UUID, else 400. Reply `{message:"ok", pingOnNextPageVisit:true}` | CA `handlers/encatch.rs:3163-3341` |
| User pending | With `userPending.enabled`, known users get `{message:"User does not exist / is pending creation", pingAgainIn:10, pingOnNextPageVisit:true}`. From the 5th try within 5 minutes: `pingAgainIn:900, userPendingRetryExhausted:true` (camelCase) | CA `handlers/encatch.rs:694-729`, `config.rs:448-458` |
| refine-text | `questionId`, `feedbackConfigurationId`, `userText` required. Reply `{message, refinedText}` | CA `handlers/encatch.rs:4016-4185` |
| upload | Multipart `formId`, `questionId`, `file`. Reply `{fileUrl}` | CA `handlers/encatch.rs:6588-6699` |
| qna-with-ai/stream | `conversation` must not be empty, else 400. SSE `chunk` `{"delta"}` events, then `done` `{"answer"}` | CA `handlers/encatch.rs:6438-6555` |

## Not modelled

- Cookieless mode, MAU and plan limits, event quotas, schedules, per-app availability and payment errors. Add them when a test needs them.
- `$feedbackTransactions`: the server keeps this state itself, by session, and ignores the field in requests (CA `cache/visitor_session_cache_service.rs`). The mock ignores it too.
- The gateway's optional pre-auth limiter (off by default).
