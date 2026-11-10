# @encatch/react-native-sdk

## 1.4.4

### Bug Fixes

* Stop request storms: the retry queue no longer sends an item twice or stalls on one bad item, identical `identifyUser` calls are sent once, and identical `trackEvent` / `trackScreen` calls within 1 second collapse to one. Every request now times out after 30 seconds.
* Back off on HTTP 429: a rate-limited call is not retried, and its group of calls pauses for `Retry-After` (60 seconds without the header, at most 5 minutes). Survey submits wait out the pause and are retried, so answers aren't lost.
* Navigation screen tracking sends a screen only when the route changes, not on every re-render, and sends the first screen once `init` finishes.
* Only one survey shows at a time: automatic shows are ignored while a survey is pending, loading or open, and `showForm` for the form already open is ignored. A show-form 404 means "not eligible now" and is no longer retried or logged as a warning.
* Surveys picked by the server in identify, ping and event replies are now shown (Immediate, Delayed and Tracked Event triggers), not only those from screen replies.
* Closing a survey with its X before the final submit is recorded as a dismissal for identified users (`dismiss-form` and `form:dismissed`). Closing on the thank-you screen, "remind me later" and call-to-action buttons are not dismissals.
* Survey events from visitors are no longer sent (the server rejected them with 403), and survey events no longer carry an empty form id.
* Identity: requests carry both identity headers or neither, so a user whose first identify failed is no longer stuck on 401s; `identifyUser` and `resetUser` no longer race; identify-user always sends the name from that call; the server's "retries exhausted" flag is now recognised.
* Secure mode: identify sends the `X-User-Signature` and `X-User-Session-Time` headers the gateway expects (secure identify always failed with 401 before). After a secure identify the signature goes on every request for that user and survives a restart. An expired signature pauses background calls until the next identify, instead of repeated 401s. The debug log masks the signature and API key.
* Ping follows the server's `pingAgainIn` on every reply, not every other one.
* `stopSession()` now lasts until `startSession()`, a successful `identifyUser()` or `resetUser()`, including across app restarts. It stops the background ping and automatic screen tracking; your own `trackScreen`, `trackEvent` and `showForm` calls still work.
* `$sdkVersion` reports the real SDK version instead of `2.0.0`.

### Features

* Optional `onRequest` and `onResponse` debug hooks in `EncatchConfig`. They report each request's endpoint, status, duration and outcome (including why a call was skipped), never keys, headers, signatures or bodies.
* "Remind me later" is sent to the server as the `form:remindmelater` event for identified users.

### Documentation

* README: when camera and microphone permissions are needed.

## 1.4.3

### Bug Fixes

* Android: the form dialog no longer jumps above the status bar when the keyboard opens on apps that are not edge-to-edge (targetSdk < 35, or Android 14 and older).
* Fix a startup crash (`Requiring unknown module "undefined"`) in bare React Native 0.73–0.80 apps that do not install the SDK's optional peers.
* iOS: keep the form height in sync after the keyboard closes.

### Features

* Add an `appPackageId` config option, and warn at init when the app package name cannot be detected instead of every API call failing silently with "referer is required".

## 1.4.3-beta.0

### Patch Changes

- 300830a: Fix the Android form dialog jumping above the status bar when the keyboard opens on apps that are not edge-to-edge (targetSdk < 35, or Android 14 and older). Fix a startup crash (`Requiring unknown module "undefined"`) in bare React Native 0.73–0.80 apps that do not install the SDK's optional peers. Add an `appPackageId` config option and warn at init when the app package name cannot be detected, instead of every API call failing silently with "referer is required".

## 1.4.2

### Patch Changes

- 6a468ca: Align dependent SDK packages with @encatch/schema@1.5.2.

## 1.4.1

### Patch Changes

- 8a5ede6: projectI18nFileUrl is nullish instead of optional
- bd30ef3: Add form validation i18n support and projectI18nFileUrl for custom CDN language packs.

## 1.4.1-beta.1

### Patch Changes

- projectI18nFileUrl is nullish instead of optional

## 1.4.1-beta.0

### Patch Changes

- Add form validation i18n support and projectI18nFileUrl for custom CDN language packs.

## 1.4.0

### Minor Changes

- Stable minor release from Mil-2026-v2-release-10: color theme updates, corners and InApp size property, React Native keyboard and form shadow fixes, and form engine styling fixes.

## 1.3.1-beta.1

### Patch Changes

- fix keyboard jittering and introduce form shadow

## 1.3.1-beta.0

### Patch Changes

- Implementation of the new corners and InApp Size Property

## 1.3.0

### Minor Changes

- Production minor release aligned with npm `latest` baselines:
  - `@encatch/schema` `1.3.0` → `1.4.0`: prepopulate fields (number, address, ranking), CSAT custom emoji, optional signature/video/audio copy fields
  - `@encatch/web-sdk` `1.3.0` → `1.4.0`: inline form rendering, zod-free public types, default `webHost` `https://form.encatch.com`
  - `@encatch/ws-react` `0.2.2` → `0.3.0`: aligned with schema `1.4.0`
  - `@encatch/event-publisher` `1.0.3` → `1.1.0`
  - `@encatch/shared-module` `0.0.8` → `0.1.0`
  - `@encatch/react-native-sdk` `1.2.0` → `1.3.0`: default `apiBaseUrl` `https://api.encatch.com`, default `webHost` `https://form.encatch.com`, exported `DEFAULT_API_BASE_URL` / `DEFAULT_WEB_HOST`

## 1.2.0

### Minor Changes

- Bug fixes since 1.1.0: recording reliability, scheduler dialog handling, and related React Native SDK fixes.

## 1.0.0

## 1.0.0-beta.0

### Major Changes

- feat: initial release for @encatch/react-native-sdk
