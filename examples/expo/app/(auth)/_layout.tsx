import { Redirect, Stack } from 'expo-router';
import { useEncatch } from '@encatch/react-native-sdk';
import { useTesterSession } from '@/contexts/TesterSessionContext';

function AuthLayoutWithEncatch() {
  const { isInitialized, isIdentified } = useEncatch();

  if (!isInitialized) return null;
  if (isIdentified) return <Redirect href="/(tabs)" />;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
    </Stack>
  );
}

export default function AuthLayout() {
  const { isSdkReady } = useTesterSession();

  if (!isSdkReady) {
    return (
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
      </Stack>
    );
  }

  return <AuthLayoutWithEncatch />;
}
