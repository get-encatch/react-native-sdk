# Expo example

Expo app for testing the `@encatch/react-native-sdk` SDK from this repository.

## Setup

1. Copy `.env.example` to `.env` and set your API key:

   ```bash
   cp .env.example .env
   # Edit .env: set EXPO_PUBLIC_ENCATCH_API_KEY
   ```

2. From the repository root, install dependencies and build the SDK:

   ```bash
   pnpm install
   pnpm build
   ```

## Run

```bash
pnpm dev
# or: pnpm start
```

Then press `i` for iOS simulator or `a` for Android emulator.

## Features

- **Login** — Mock login calls `identifyUser(username)`
- **Home** — Track event: `home_viewed`
- **Events** — Buttons for `button_clicked`, `feature_used`, `purchase_started`, `survey_viewed`
- **Settings** — Logout calls `resetUser()`
- **Screen tracking** — Expo Router auto-tracks via `navigationType="expo-router"`
- **Billing** — Destination for `completionCta` `app_navigate` routes (`billing`, `billing/upgrade`)
- **CTA navigation** — `CtaNavigationHandler` maps `form:ctaTriggered` events to `/billing` or `/route-not-found`

## Manual test checklist

1. **Setup:** Copy `.env` with `EXPO_PUBLIC_ENCATCH_API_KEY` (and optional form IDs). Run the app and log in.
2. **Exact inline:** **Inline (Exact)** → show embedded form.
3. **Wildcard inline:** **Inline (Any)** → enter a form id → show embedded form.
4. **Home modal:** **Home** → show form → opens as modal overlay.
5. **Interceptor:** **Home** → interceptor test → blocked WebView, native modal carousel.
6. **app_navigate (billing):** Configure a thank-you screen with `completionCta.inApp: { action: "app_navigate", route: "billing" }` (or `"billing/upgrade"`). Complete the form and tap the CTA. Expect the overlay to close (SDK) and navigation to **Billing**.
7. **app_navigate (404):** Use a form with an unmapped route such as `"does/not/exist"`. Complete and tap the CTA. Expect **Route not found** with the requested route, then **Go back**.
8. **exit_form + app_navigate + delay:** `exit_form` with `action: "app_navigate"`, `route: "billing"`, and `autoTriggerDelayMs: 5000`. Submit from an inline tab — form clears immediately; ~5s later navigation to Billing (SDK timer, no host timer).

## Environment variables

| Variable | Description |
|----------|-------------|
| `EXPO_PUBLIC_ENCATCH_API_KEY` | Optional default API key for the setup screen (overridden by saved local value) |
| `EXPO_PUBLIC_ENCATCH_API_BASE_URL` | API base URL (default: https://api.encatch.com) |
| `EXPO_PUBLIC_ENCATCH_WEB_HOST` | WebView host (default: https://form.encatch.com) |
| `EXPO_PUBLIC_ENCATCH_FORM_ID` | Optional comma-separated defaults for the form id picker |

On launch, the setup screen asks for **API key** and **feedback configuration ID** (required). Both are saved locally and restored on the next launch until you tap **Clear saved setup** in Settings. You can change the form id on Home / Inline tabs without rebuilding. Set an optional **interceptor test form ID** on setup to enable the native interceptor carousel demo.
