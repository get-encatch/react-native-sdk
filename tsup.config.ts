import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  // Inline @encatch/schema's type definitions into the emitted .d.ts so
  // consumers don't need the schema package installed. zod stays external
  // (kept as `import { z } from 'zod'`) because rollup-plugin-dts cannot
  // inline zod's type-only namespace exports.
  dts: {
    resolve: true,
  },
  noExternal: ['@encatch/schema'],
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: false,
  external: [
    'react',
    'react-native',
    'react-native-webview',
    '@react-native-async-storage/async-storage',
    '@react-navigation/native',
    'expo-device',
    'expo-localization',
    'expo-router',
    'react-native-localize',
    'react-native-device-info',
    'zod',
    // Optional-peer loaders must stay separate modules in the consumer's
    // Metro bundle, so keep them as runtime requires (see optional/*.js).
    /^\.\.\/optional\//,
  ],
  // The SDK reports this as $sdkVersion (see SDK_VERSION in src/encatch.ts).
  define: { __ENCATCH_SDK_VERSION__: JSON.stringify(version) },
  platform: 'neutral',
  target: 'es2017',
  esbuildOptions(options) {
    options.jsx = 'preserve';
  },
});
