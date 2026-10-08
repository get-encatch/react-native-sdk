# Releasing

Releases are made **locally** by a maintainer with publish rights on the `@encatch` npm scope, using [release-it](https://github.com/release-it/release-it). CI never publishes.

## Branches and versions

| Branch | Releases | npm dist-tag |
|---|---|---|
| `main` | Pre-releases: `x.y.z-beta.N`, then `x.y.z-rc.N` | `beta` (or `rc`) |
| `release/x.y` | Stable `x.y.z` and patches `x.y.(z+1)` | `latest` |

- Versions follow [SemVer](https://semver.org).
- Every release is an annotated git tag `vX.Y.Z` with a matching GitHub Release.
- Fixes land on `main` first and are cherry-picked to `release/*` branches.

## One-time setup

- npm: `npm login` with an account that has publish rights on `@encatch` and 2FA enabled.
- GitHub: push access to this repository.

## First release from this repository (once)

The first release from this repository is the stable `1.4.3` (npm `latest`). `1.4.3-beta.0` was published before the SDK moved here, so the repository has no version tag yet, and the import commit's changes (including an iOS fix that is not in `1.4.3-beta.0`) are not Conventional Commits that release-it can turn into a changelog. So the notes for `1.4.3` are written by hand, once:

1. Tag the import commit on `main` (`chore: import React Native SDK and example apps`, whose `package.json` says `1.4.3-beta.0`). Without this tag, release-it builds the changelog from the repository's very first commit.

   ```bash
   git switch main && git pull
   git tag -a v1.4.3-beta.0 <import-commit-sha> -m "v1.4.3-beta.0 (published before the move to this repository)"
   git push origin v1.4.3-beta.0
   ```

2. Create the release branch, add a `## 1.4.3` section at the top of `CHANGELOG.md` (below the title), commit it and push the branch (release-it needs the branch to exist on GitHub):

   ```bash
   git switch -c release/1.4
   # edit CHANGELOG.md
   git commit -am "docs: add 1.4.3 release notes to the changelog"
   git push -u origin release/1.4
   ```

   ```markdown
   ## 1.4.3

   ### Bug Fixes

   * Android: the form dialog no longer jumps above the status bar when the keyboard opens on apps that are not edge-to-edge (targetSdk < 35, or Android 14 and older).
   * Fix a startup crash (`Requiring unknown module "undefined"`) in bare React Native 0.73–0.80 apps that do not install the SDK's optional peers.
   * iOS: keep the form height in sync after the keyboard closes.

   ### Features

   * Add an `appPackageId` config option, and warn at init when the app package name cannot be detected instead of every API call failing silently with "referer is required".
   ```

3. Release `1.4.3` from `release/1.4`, telling release-it not to write its own changelog section this one time:

   ```bash
   pnpm release 1.4.3 --no-plugins.@release-it/conventional-changelog.infile
   ```

4. On the GitHub Release page that opens, replace the generated notes with the `1.4.3` section from step 2, then publish it.

5. Bring the changelog and version bump back to `main` with a pull request from `release/1.4` (merge commit, not squash, so the `v1.4.3` tag stays on `main`'s history).

6. Optional: point the `beta` dist-tag at `1.4.3` too, so `@beta` installs do not stay on the older `1.4.3-beta.0`:

   ```bash
   npm dist-tag add @encatch/react-native-sdk@1.4.3 beta
   ```

From the next release on, follow the normal commands below.

## Checklist before releasing

- [ ] On the right branch (`main` for pre-releases, `release/x.y` for stable), working tree clean, up to date with GitHub.
- [ ] `pnpm install` and `pnpm typecheck` pass.
- [ ] Test matrix passes with the SDK built from this commit:
  - [ ] Android 13, 14 and 15: open a form with a short answer and a long answer; the dialog sits just above the keyboard, its title stays below the status bar, and it drops back when the keyboard closes.
  - [ ] `examples/expo` **release** build.
  - [ ] `examples/bare` **release** build (no optional peers installed).
  - [ ] iOS simulator.
- [ ] `pnpm pack:check` lists only `dist/`, `optional/`, `README.md`, `LICENSE` and `package.json`.

## Release commands

Run from the repository root. release-it checks the branch, runs the type check, bumps the version, updates `CHANGELOG.md`, builds, commits, tags, pushes, publishes to npm and opens the GitHub Release page.

```bash
# Pre-release from main (e.g. 1.5.0-beta.0, then 1.5.0-beta.1, ...)
pnpm release --preRelease=beta

# Stable release from a release branch
git switch -c release/1.5 main     # first stable release of 1.5 only
pnpm release

# Patch on an existing release branch
git switch release/1.5
git cherry-pick <commit-from-main>
pnpm release patch
```

Add `--dry-run` to any command to see what would happen without changing anything.

When npm asks for two-factor authentication, it prints a link: open it and approve in the browser. release-it then opens a prefilled GitHub Release page in your browser; publish it there.

## After releasing

```bash
npm view @encatch/react-native-sdk dist-tags
```

Check that `latest` and `beta` point to the expected versions. If a stable release was made on a release branch, merge or cherry-pick the version bump and `CHANGELOG.md` entry back to `main` if needed.

## Notes

- Local releases do not carry npm provenance (provenance can only be generated by hosted CI). This can be added later with npm trusted publishing from GitHub Actions without changing this process.
- Never publish from a dirty working tree or from a branch other than `main` or `release/*`; release-it refuses both.
