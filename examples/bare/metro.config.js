const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withEncatchSdk } = require('../../scripts/metro-sdk');

/**
 * Metro configuration for the bare example.
 *
 * Only this app's node_modules is searched, and the SDK at the repository root
 * resolves its imports from this app (see scripts/metro-sdk.js). The SDK's
 * optional peers are not installed here, so they stay missing on purpose.
 *
 * https://reactnative.dev/docs/metro
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
});

module.exports = withEncatchSdk(config, __dirname);
