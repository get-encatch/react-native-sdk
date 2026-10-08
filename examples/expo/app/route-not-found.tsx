import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useEncatch } from '@encatch/react-native-sdk';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { popToPreviousOrHome } from '@/navigation/ctaDestinationNavigation';

/** Shown when a completionCta `app_navigate` route is not mapped in the tester. */
export default function RouteNotFoundScreen() {
  const router = useRouter();
  const { route: routeParam } = useLocalSearchParams<{ route?: string }>();
  const { isInitialized, isIdentified } = useEncatch();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];

  const routeLabel =
    typeof routeParam === 'string' && routeParam.length > 0 ? routeParam : '(no route provided)';

  if (!isInitialized) return null;
  if (!isIdentified) return <Redirect href="/(auth)/login" />;

  return (
    <>
      <Stack.Screen options={{ title: 'Route not found' }} />
      <ScrollView
        style={[styles.scroll, { backgroundColor: colors.background }]}
        contentContainerStyle={styles.container}>
        <SymbolView
          name={{ ios: 'exclamationmark.triangle', android: 'error_outline', web: 'error_outline' }}
          tintColor="#EF4444"
          size={64}
        />
        <Text style={[styles.title, { color: colors.text }]}>404 — Route not found</Text>
        <Text style={[styles.body, { color: colors.tabIconDefault }]}>
          The form emitted an app_navigate CTA with a route that is not mapped in this tester
          app.
        </Text>
        <Text style={[styles.label, { color: colors.text }]}>Requested route</Text>
        <Text style={[styles.mono, { color: colors.text }]} selectable>
          {routeLabel}
        </Text>
        <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={() => popToPreviousOrHome(router)}>
          <Text style={styles.buttonText}>Go back</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    padding: 24,
    alignItems: 'flex-start',
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
    marginTop: 16,
  },
  body: {
    fontSize: 16,
    marginTop: 8,
    lineHeight: 22,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 16,
  },
  mono: {
    fontSize: 16,
    fontFamily: 'SpaceMono',
    marginTop: 4,
  },
  separator: {
    marginVertical: 24,
    height: 1,
    width: '100%',
  },
  button: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
