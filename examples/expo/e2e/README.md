# End-to-end flows (mock API only)

Maestro flows for the example app, run against the local mock API (`examples/mock-api`). Nothing here talks to dev, UAT or production.

## Run

1. Start the mock: `pnpm --filter @encatch/mock-api dev`
2. Install a release build of this app on a simulator or emulator (`npx expo run:ios --configuration Release`, or `./android/gradlew -p android assembleRelease` and `adb install`).
   - After changing the SDK, run `pnpm build` first. On Android, also add `:app:createBundleReleaseJsAndAssets --rerun` to the Gradle command: Gradle doesn't track the SDK's `dist/` (it lives outside the app), so it can keep the old JavaScript bundle and report the task as UP-TO-DATE.
3. Run the flows:

```bash
node examples/expo/e2e/run.mjs --platform ios --device <simulator udid>
node examples/expo/e2e/run.mjs --platform android --device emulator-5554 --only E1,E5
```

The runner stops the app on both platforms, resets the mock and sets each flow's scenario, runs the flow, then checks the requests the mock received. Screenshots and request logs for failed flows go to `e2e/.results/` (git-ignored), or to `--out <dir>`.

## Flows

| # | Flow | Checks |
|---|---|---|
| E1 | Login → identify → navigate tabs | One identify; both identity headers on every later request; no 401 |
| E2 | Burst screen: each burst button; the survey is closed with its X | One request per distinct call; one show-form; no 401 or 404; the X-close sends one dismiss-form and one `form:dismissed` |
| E3 | Screen with a survey, opened repeatedly before it shows | One show-form; no 404 |
| E4a–c | Survey from the identify, track-event and ping replies | Each shows once; no ping while it is open |
| E5 | Answer and submit a survey | One submit-form 200; survey events sent for the identified user; no dismissal |
| E6 | Visitor sees a survey and closes it with the X | No survey events, no dismiss-form; no 403 |
| E7 | `planned-prod` and `per-endpoint-5` bursts that hit 429 | No retries of 429'd calls; nothing sent while paused; submit still works; traffic resumes |
| E8 | Secure identify, valid or wrong signature, key with and without a session time | 200 and signed later requests, or 401 and no identified requests |
| E9 | Logout, then log in as another user | New identity on every later request; no mixed headers |
| E10 | Background and return during a 429 pause | Nothing sent while paused; no event sent twice; no burst on return |
| E11 | Debug hooks | `onRequest` / `onResponse` once per request; collapsed calls reported as skipped; no key in reports |

## What the example adds for these flows (Mock environment only)

- `constants/mockTools.ts`: the debug hooks report to `POST /__mock/hooks`; secure identify gets its signature from `GET /__mock/sign` (standing in for the customer's backend).
- Test IDs on the setup, login, Home and tab buttons, and a signature option (none / valid / wrong) on the login screen.

## Checks against a real dev API (`run-dev.mjs`)

`run-dev.mjs` runs the DV and V checks against a real **test** project on the dev API (no bursts or rate-limit tests; those stay on the mock). The app talks to the dev API; the local mock only collects what the example reports in its DEV environment (each request's outcome from the debug hooks, the shown form's id, and the SDK's app events).

| # | Check |
|---|---|
| DV1 | Identified user: manual form, answer, submit, close the thank-you screen (not a dismissal) |
| DV2, DV3 | Identified user: X on the welcome screen, or after rating, is a dismissal (`dismiss-form` 200, `form:dismissed` with the form id) |
| DV4–DV7 | Page visit, tracked event, immediate and delayed triggers each show the right form once |
| DV8 | A new user signs in, logs out, signs in again as an existing user |
| V1–V4 | Visitor: manual submit, page visit, event and immediate triggers; the X sends nothing |

**Set up the test project once** (in the admin):
1. A publishable SDK key allowed for `com.encatch.expotester`, with new contacts allowed.
2. Five published forms, each with a welcome screen titled "Welcome to the RN SDK test survey", a rating question ("How would you rate…", labels Poor/Excellent), a long-answer question ("Describe how the application fits…") and a thank-you screen ("Thank you! Your input makes a difference."). Visitors and all logged-in users; recurrence off. Triggers: manual only; page visit (contains "dev-page"); tracked event `dev_event`; immediate (include pages containing "dev-immediate"); delayed 20 s after session start (include pages containing "dev-delayed").
3. Copy `dev-project.example.json` to `.results/dev-project.json` (git-ignored) and fill in the key and form ids.

```bash
node examples/expo/e2e/run-dev.mjs --platform android --device emulator-5554
```
