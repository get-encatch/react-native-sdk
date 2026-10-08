# @encatch/react-native-sdk

The Encatch React Native SDK lets you collect user feedback in your React Native and Expo apps. Display feedback forms in using native with encatch hooks or a WebView overlay, identify users, track screens and events, and submit responses to the Encatch backend.

> **Note:** Install the latest stable release from npm. Pre-release builds remain available under the `@beta` tag.

## Installation

```bash
npm install @encatch/react-native-sdk
# or
yarn add @encatch/react-native-sdk
# or
pnpm add @encatch/react-native-sdk
```

## Documentation

For the full API reference, configuration options, and usage examples, visit the official documentation:

**[https://encatch.com/docs/sdk-reference/mobile-sdk/react-native](https://encatch.com/docs/sdk-reference/mobile-sdk/react-native)**

## Default hosts

Production defaults (override via `EncatchConfig` when needed):

| Option | Default |
|--------|---------|
| `apiBaseUrl` | `https://api.encatch.com` |
| `webHost` | `https://form.encatch.com` |

These are exported as `DEFAULT_API_BASE_URL` and `DEFAULT_WEB_HOST` from the package.

## Repository layout

| Path | What it is |
|---|---|
| Repository root (`src/`, `optional/`) | The SDK, published to npm as `@encatch/react-native-sdk` |
| [`examples/expo`](examples/expo) | Expo example app used to test the SDK |
| [`examples/bare`](examples/bare) | Bare React Native example app (no Expo, no optional peers) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the development workflow, and [RELEASING.md](RELEASING.md) for how releases are made.

## Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Phyder Mobile Solutions Pvt. Ltd.
 