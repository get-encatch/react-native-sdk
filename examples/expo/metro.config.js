// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const { withEncatchSdk } = require('../../scripts/metro-sdk');

// Resolves the SDK from the repository root; see scripts/metro-sdk.js.
module.exports = withEncatchSdk(getDefaultConfig(__dirname), __dirname);
