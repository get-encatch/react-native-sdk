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

## Camera and microphone permissions

The SDK never asks for camera or microphone access by itself. The system prompt appears only when a form question needs it (for example a photo, video or audio answer), the first time that question is used. Your app controls this through the permissions it declares:

- **No camera or microphone questions in your forms:** declare nothing. Your users are never asked.
- **Forms with camera or microphone questions:** declare the permissions below. Without them, those questions can't capture anything.

| Platform | What to add |
|---|---|
| Android (`AndroidManifest.xml`) | `<uses-permission android:name="android.permission.CAMERA" />` and `<uses-permission android:name="android.permission.RECORD_AUDIO" />` |
| iOS (`Info.plist`) | `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`, each with a sentence telling users why you need it |

With Expo, add them in `app.json`:

```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "NSCameraUsageDescription": "Allow camera access to answer feedback questions with a photo or video.",
        "NSMicrophoneUsageDescription": "Allow microphone access to answer feedback questions with audio."
      }
    },
    "android": {
      "permissions": ["CAMERA", "RECORD_AUDIO"]
    }
  }
}
```

The [Expo example](examples/expo) asks for both permissions as soon as it starts so testers can try every question type. Your app doesn't need to do that.

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
 