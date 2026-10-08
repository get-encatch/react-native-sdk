import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Camera } from 'expo-camera';
import { useCallback, useEffect, useState } from 'react';

import { EncatchProvider, EncatchWebView } from '@encatch/react-native-sdk';
import { useColorScheme } from '@/components/useColorScheme';
import { CtaNavigationHandler } from '@/components/CtaNavigationHandler';
import { InterceptorCarousel, type BlockedFormItem } from '@/components/InterceptorCarousel';
import { NativeForm } from '@/components/NativeForm';
import {
  TesterConfigProvider,
  loadStoredTesterSetup,
  type TesterSetupValues,
  useTesterConfig,
} from '@/contexts/TesterConfigContext';
import { TestUsersProvider } from '@/contexts/TestUsersContext';
import { TesterSessionProvider } from '@/contexts/TesterSessionContext';
import { getEnvironmentEndpoints } from '@/constants/environments';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(auth)',
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return <RootLayoutNav />;
}

async function requestMediaPermissions() {
  try {
    const camera = await Camera.requestCameraPermissionsAsync();
    const microphone = await Camera.requestMicrophonePermissionsAsync();

    if (camera.status !== 'granted' || microphone.status !== 'granted') {
      console.warn('[EncatchExpoTester] Camera or microphone permission was not granted.');
    }
  } catch (err) {
    console.warn('[EncatchExpoTester] Failed to request media permissions:', err);
  }
}

function EncatchAppInner({
  setupValues,
  blockedForms,
  nativeFormVisible,
  selectedFormConfig,
  onAddBlockedForm,
  onRemoveBlockedForm,
  onCarouselItemPress,
  onCloseNativeForm,
}: {
  setupValues: TesterSetupValues;
  blockedForms: BlockedFormItem[];
  nativeFormVisible: boolean;
  selectedFormConfig: BlockedFormItem['formConfig'] | null;
  onAddBlockedForm: (formTitle: string, formConfig: BlockedFormItem['formConfig']) => void;
  onRemoveBlockedForm: (id: string) => void;
  onCarouselItemPress: (item: BlockedFormItem) => void;
  onCloseNativeForm: () => void;
}) {
  const colorScheme = useColorScheme();
  const { interceptorFormId } = useTesterConfig();
  const endpoints = getEnvironmentEndpoints(setupValues.environment);

  return (
    <EncatchProvider
      key={`${setupValues.apiKey}-${setupValues.environment}`}
      apiKey={setupValues.apiKey}
      config={{
        apiBaseUrl: endpoints.apiBaseUrl,
        webHost: endpoints.webHost,
        debugMode: true,
        onBeforeShowForm: async (payload) => {
          const interceptorId = interceptorFormId.trim();
          if (interceptorId && payload.formId === interceptorId) {
            const formConfig = payload.formConfig as BlockedFormItem['formConfig'];
            const formTitle = formConfig?.formConfiguration?.formTitle ?? 'Form';
            onAddBlockedForm(formTitle, formConfig);
            return false;
          }
          return true;
        },
      }}
      navigationType="expo-router">
      <EncatchWebView />
      <CtaNavigationHandler />
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="edit-profile"
            options={{ headerShown: true, presentation: 'modal', title: 'Edit profile' }}
          />
          <Stack.Screen name="billing" options={{ headerShown: true }} />
          <Stack.Screen name="route-not-found" options={{ headerShown: true }} />
        </Stack>
      </ThemeProvider>
      <InterceptorCarousel
        items={blockedForms}
        onRemove={onRemoveBlockedForm}
        onItemPress={onCarouselItemPress}
      />
      <NativeForm
        visible={nativeFormVisible}
        formConfig={selectedFormConfig}
        onClose={onCloseNativeForm}
      />
    </EncatchProvider>
  );
}

function TesterAppShell({ setupValues }: { setupValues: TesterSetupValues }) {
  const colorScheme = useColorScheme();
  const [blockedForms, setBlockedForms] = useState<BlockedFormItem[]>([]);
  const [nativeFormVisible, setNativeFormVisible] = useState(false);
  const [selectedFormConfig, setSelectedFormConfig] = useState<BlockedFormItem['formConfig'] | null>(
    null
  );

  const isSdkReady = setupValues.apiKey.trim().length > 0;
  const shellKey = `${setupValues.apiKey}-${setupValues.environment}-${setupValues.formId}`;

  const addBlockedForm = useCallback((formTitle: string, formConfig: BlockedFormItem['formConfig']) => {
    setBlockedForms((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        formTitle,
        formConfig,
      },
    ]);
  }, []);

  const removeBlockedForm = useCallback((id: string) => {
    setBlockedForms((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleCarouselItemPress = useCallback((item: BlockedFormItem) => {
    setSelectedFormConfig(item.formConfig);
    setNativeFormVisible(true);
  }, []);

  if (!isSdkReady) {
    return (
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
        </Stack>
      </ThemeProvider>
    );
  }

  return (
    <TesterConfigProvider
      key={shellKey}
      initialFormId={setupValues.formId}
      initialInterceptorFormId={setupValues.interceptorFormId}>
      <EncatchAppInner
        setupValues={setupValues}
        blockedForms={blockedForms}
        nativeFormVisible={nativeFormVisible}
        selectedFormConfig={selectedFormConfig}
        onAddBlockedForm={addBlockedForm}
        onRemoveBlockedForm={removeBlockedForm}
        onCarouselItemPress={handleCarouselItemPress}
        onCloseNativeForm={() => setNativeFormVisible(false)}
      />
    </TesterConfigProvider>
  );
}

function RootLayoutNav() {
  const [setupValues, setSetupValues] = useState<TesterSetupValues | null>(null);

  useEffect(() => {
    void loadStoredTesterSetup().then((values) => {
      setSetupValues(values);
      if (values.apiKey.trim()) {
        void requestMediaPermissions();
      }
    });
  }, []);

  const handleSetupChange = useCallback((values: TesterSetupValues) => {
    setSetupValues(values);
    if (values.apiKey.trim()) {
      void requestMediaPermissions();
    }
  }, []);

  if (setupValues === null) {
    return null;
  }

  return (
    <TestUsersProvider>
      <TesterSessionProvider initialSetup={setupValues} onSetupChange={handleSetupChange}>
        <TesterAppShell key={setupValues.apiKey + setupValues.environment} setupValues={setupValues} />
      </TesterSessionProvider>
    </TestUsersProvider>
  );
}
