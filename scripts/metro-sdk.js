/**
 * Shared Metro setup for the example apps in examples/*.
 *
 * The SDK lives at the repository root and is linked into each example app.
 * The root node_modules holds the SDK's development dependencies (its own
 * react, react-native, ... used for type checking), which must never end up in
 * an app bundle. To behave exactly like an `npm install` of the SDK:
 *
 * - every package import made by the SDK's files (src/, dist/, optional/)
 *   resolves from the APP, so the app's react / react-native / peers are used;
 * - except the SDK's own runtime "dependencies" (package.json), which resolve
 *   from the SDK, as npm would install them alongside it.
 *
 * Optional peers the app does not install (expo-*, react-native-device-info,
 * ...) therefore stay missing, which is what exercises the SDK's
 * "optional peer not installed" code paths in the bare example.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sdkDirs = ['src', 'dist', 'optional'].map((dir) => path.join(root, dir) + path.sep);
const sdkRuntimeDeps = new Set(
  Object.keys(require(path.join(root, 'package.json')).dependencies ?? {})
);

const packageName = (moduleName) =>
  moduleName.startsWith('@')
    ? moduleName.split('/').slice(0, 2).join('/')
    : moduleName.split('/')[0];

/**
 * @param {import('metro-config').MetroConfig} config the app's default Metro config
 * @param {string} appDir the example app's directory (__dirname of its metro.config.js)
 */
function withEncatchSdk(config, appDir) {
  const appOrigin = path.join(appDir, 'package.json');
  const sdkOrigin = path.join(root, 'package.json');
  // When the app installs the SDK from npm instead of the workspace (for example to
  // test a published beta), pnpm keeps one copy shared by every app and links the
  // other apps' optional peers next to it. Treat that copy like the repository's:
  // its package imports resolve from this app, as with a plain npm install.
  let installedSdkDirs = [];
  try {
    const installed = fs.realpathSync(path.join(appDir, 'node_modules', '@encatch', 'react-native-sdk'));
    if (installed !== root) installedSdkDirs = ['src', 'dist', 'optional'].map((dir) => path.join(installed, dir) + path.sep);
  } catch {
    /* not installed */
  }
  const sdkFileDirs = [...sdkDirs, ...installedSdkDirs];
  const previousResolveRequest = config.resolver?.resolveRequest;

  return {
    ...config,
    watchFolders: [...new Set([...(config.watchFolders ?? []), root])],
    resolver: {
      ...config.resolver,
      resolveRequest: (context, moduleName, platform) => {
        const resolve = previousResolveRequest ?? context.resolveRequest;
        const origin = context.originModulePath;
        const isPackageImport = !moduleName.startsWith('.') && !path.isAbsolute(moduleName);
        const fromSdkFiles = sdkFileDirs.some((dir) => origin.startsWith(dir));

        if (isPackageImport && fromSdkFiles) {
          const resolveFrom = sdkRuntimeDeps.has(packageName(moduleName)) ? sdkOrigin : appOrigin;
          return resolve({ ...context, originModulePath: resolveFrom }, moduleName, platform);
        }
        return resolve(context, moduleName, platform);
      },
    },
  };
}

module.exports = { withEncatchSdk };
