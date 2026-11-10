import { defineConfig } from 'vitest/config';
import { transformWithEsbuild } from 'vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// Unit tests run in Node. React Native and AsyncStorage are replaced with small
// in-memory mocks; optional peers are not installed at the repository root, so
// the loaders in ../optional/ resolve to null exactly as in a bare app.
export default defineConfig({
  // Same as tsup.config.ts: the SDK reports this as $sdkVersion.
  define: { __ENCATCH_SDK_VERSION__: JSON.stringify(version) },
  plugins: [
    {
      // The published package (`sdk-1.4.3`, used by test/characterization) ships
      // JSX inside dist/*.js, which Metro compiles in apps. Compile it here too.
      name: 'jsx-in-published-sdk',
      enforce: 'pre',
      transform(code, id) {
        if (!/@encatch\/react-native-sdk\/dist\/index\.m?js$/.test(id)) return null;
        return transformWithEsbuild(code, id, { loader: 'jsx', jsx: 'automatic' });
      },
    },
  ],
  resolve: {
    alias: {
      'react-native': path.resolve(__dirname, 'test/mocks/react-native.ts'),
      '@react-native-async-storage/async-storage': path.resolve(
        __dirname,
        'test/mocks/async-storage.ts'
      ),
      'react-native-webview': path.resolve(__dirname, 'test/mocks/react-native-webview.ts'),
      'react-native-safe-area-context': path.resolve(__dirname, 'test/mocks/react-native-safe-area-context.ts'),
      // The published 1.4.3 package, as its ES module build so every import goes
      // through the aliases above (its CommonJS build would require the real
      // react-native).
      'sdk-1.4.3': path.resolve(__dirname, 'node_modules/sdk-1.4.3/dist/index.mjs'),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'examples/mock-api/test/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        // The published 1.4.3 package (test/characterization) must go through the
        // aliases above, so React Native and AsyncStorage are mocked for it too.
        inline: [/react-native-sdk@1\.4\.3/, /sdk-1\.4\.3/],
      },
    },
  },
});
