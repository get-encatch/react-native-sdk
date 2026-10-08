import { Redirect, Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useEncatch } from '@encatch/react-native-sdk';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { popToPreviousOrHome } from '@/navigation/ctaDestinationNavigation';

/** Sample destination for completionCta `app_navigate` billing routes. */
export default function BillingScreen() {
  const router = useRouter();
  const { isInitialized, isIdentified } = useEncatch();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];

  if (!isInitialized) return null;
  if (!isIdentified) return <Redirect href="/(auth)/login" />;

  return (
    <>
      <Stack.Screen options={{ title: 'Billing' }} />
      <ScrollView
        style={[styles.scroll, { backgroundColor: colors.background }]}
        contentContainerStyle={styles.container}>
        <SymbolView
          name={{ ios: 'doc.text', android: 'receipt_long', web: 'receipt_long' }}
          tintColor={colors.tint}
          size={64}
        />
        <Text style={[styles.title, { color: colors.text }]}>Billing</Text>
        <Text style={[styles.body, { color: colors.tabIconDefault }]}>
          This screen is the in-app destination for completionCta routes such as
          &quot;billing&quot; or &quot;billing/upgrade&quot;.
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
