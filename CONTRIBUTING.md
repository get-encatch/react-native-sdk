# Contributing

Thanks for helping improve the Encatch React Native SDK.

## Requirements

- Node.js 20 or later
- [pnpm](https://pnpm.io) (version pinned in `package.json` → `packageManager`; enable with `corepack enable`)
- For running the example apps: Android Studio and/or Xcode, set up as described in the [React Native environment guide](https://reactnative.dev/docs/set-up-your-environment)

## Setup

```bash
pnpm install      # also builds the SDK into dist/ (the "prepare" script)
pnpm build        # rebuild the SDK after changes
```

The example apps use the SDK's built `dist/` output (the same files that are published to npm), so rebuild after changing the SDK, or keep `pnpm build:watch` running.

## Workspace

| Path | Package |
|---|---|
| Repository root (`src/`, `optional/`) | `@encatch/react-native-sdk` (published) |
| `examples/expo` | Expo example (private) |
| `examples/bare` | Bare React Native example (private) |
| `scripts/metro-sdk.js` | Shared Metro setup that links the SDK into the example apps |

Both example apps use the same React Native version. Keep them aligned when upgrading, so the workspace contains a single copy of `react` and `react-native`. The examples' Metro configs resolve every import made by the SDK from the app itself, never from the SDK's development dependencies at the repository root.

## Running the examples

**Expo example** (`examples/expo`): copy `.env.example` to `.env` and fill in your API key, then:

```bash
cd examples/expo
npx expo run:android   # or: npx expo run:ios
```

**Bare example** (`examples/bare`): copy `example.config.example.json` to `example.config.json` and fill in your API key and form id, then:

```bash
cd examples/bare
pnpm start
pnpm android           # or: bundle install && cd ios && bundle exec pod install && cd .. && pnpm ios
```

After changing the SDK, a **release** build may reuse a stale JavaScript bundle, because the SDK lives outside the app folder. Rebuild the SDK first (`pnpm build`), then on Android delete `android/app/build/generated/assets` (or run Gradle with `--rerun-tasks`) before `assembleRelease`.

The bare example deliberately does not install the SDK's optional peers (`expo-*`, `react-native-device-info`, ...). Do not add them: it is how we test that the SDK works without them.

Never commit `.env` or `example.config.json`; both are gitignored.

## Checks

```bash
pnpm typecheck    # SDK type check
pnpm build        # SDK build
pnpm pack:check   # lists the files that would be published
```

CI runs the same checks on every pull request.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org). The changelog and version bumps are generated from them.

| Prefix | Use for | Version bump |
|---|---|---|
| `fix:` | Bug fixes | patch |
| `feat:` | New features | minor |
| `feat!:` / `BREAKING CHANGE:` | Breaking changes | major |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | Everything else | none |

Pull requests are squash-merged, so the pull request title must follow the same format.

## Branches

Long-lived branches:

- `main`: all development. Open pull requests against `main`.
- `release/x.y`: stable branches, one per minor version. Fixes are made on `main` first and then cherry-picked to the release branches that need them.

Work branches are short-lived, branched from `main`, and named `<type>/<short-description>` using the same types as commit messages:

| Prefix | Use for | Example |
|---|---|---|
| `feat/` | New features | `feat/inline-form-min-height` |
| `fix/` | Bug fixes | `fix/android-keyboard-offset` |
| `docs/` | Documentation | `docs/bare-setup-guide` |
| `chore/` | Repository setup, dependencies, tooling | `chore/upgrade-tsup` |
| `refactor/` | Code changes that neither fix a bug nor add a feature | `refactor/webview-bridge` |
| `test/` | Tests | `test/retry-queue` |
| `ci/` | CI configuration | `ci/android-build` |

- Use lowercase and hyphens, and keep the description short.
- If there is an issue, put its number first: `fix/42-android-keyboard-offset`.
- Delete the branch after the pull request is merged.

See [RELEASING.md](RELEASING.md) for the release process.
