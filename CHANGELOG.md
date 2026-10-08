# @encatch/react-native-sdk

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
