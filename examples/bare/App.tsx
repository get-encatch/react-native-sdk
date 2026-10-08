/**
 * Encatch React Native SDK: bare React Native example.
 *
 * Plain React Native (no Expo) with only the SDK's required peer dependencies:
 * react-native-webview, react-native-safe-area-context and
 * @react-native-async-storage/async-storage. None of the optional peers
 * (expo-*, react-native-device-info, ...) are installed, so this app checks
 * that the SDK starts and works without them.
 *
 * Settings come from example.config.json (copy example.config.example.json).
 *
 * @format
 */

import React, { useState } from 'react';
import {
  Button,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  EncatchInlineForm,
  EncatchProvider,
  EncatchWebView,
  useEncatch,
} from '@encatch/react-native-sdk';
import exampleConfig from './example.config.json';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <EncatchProvider
        apiKey={exampleConfig.apiKey}
        config={{
          apiBaseUrl: exampleConfig.apiBaseUrl,
          webHost: exampleConfig.webHost,
          // Bare React Native cannot detect the app package name without
          // react-native-device-info. Leave empty to see the SDK's warning.
          appPackageId: exampleConfig.appPackageId || undefined,
          debugMode: true,
        }}>
        {/* Hosts modal (bottom sheet / popup) forms. */}
        <EncatchWebView />
        <HomeScreen />
      </EncatchProvider>
    </SafeAreaProvider>
  );
}

function HomeScreen() {
  const { isInitialized, isIdentified, userName, identifyUser, showForm, resetUser } =
    useEncatch();
  const [showInline, setShowInline] = useState(false);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Encatch bare example</Text>
        <Text style={styles.status}>
          SDK initialized: {isInitialized ? 'yes' : 'no'}
          {'\n'}User: {isIdentified ? userName : 'not identified'}
          {'\n'}Form: {exampleConfig.formId}
          {'\n'}appPackageId: {exampleConfig.appPackageId || '(auto-detect)'}
        </Text>

        <View style={styles.button}>
          <Button
            title={`Identify "${exampleConfig.userName}"`}
            onPress={() => identifyUser(exampleConfig.userName)}
          />
        </View>
        <View style={styles.button}>
          <Button
            title={showInline ? 'Show form (inline slot below)' : 'Show form (modal)'}
            onPress={() => showForm(exampleConfig.formId)}
          />
        </View>
        <View style={styles.button}>
          <Button
            title={showInline ? 'Unmount inline slot' : 'Mount inline slot'}
            onPress={() => setShowInline(prev => !prev)}
          />
        </View>
        <Text style={styles.hint}>
          While the inline slot is mounted, showForm() for this form renders inside
          it instead of as a modal.
        </Text>
        <View style={styles.button}>
          <Button title="Reset user" onPress={resetUser} color="#c0392b" />
        </View>

        {showInline && (
          <EncatchInlineForm formId={exampleConfig.formId} style={styles.inline} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    padding: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    marginBottom: 12,
  },
  status: {
    fontSize: 14,
    marginBottom: 24,
    lineHeight: 22,
  },
  button: {
    marginBottom: 12,
  },
  hint: {
    fontSize: 12,
    color: '#888',
    marginBottom: 12,
  },
  inline: {
    marginTop: 12,
  },
});

export default App;
