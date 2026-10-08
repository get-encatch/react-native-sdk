import { StyleSheet, Pressable, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Text, View } from '@/components/Themed';
import { useEncatch } from '@encatch/react-native-sdk';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useTesterSession } from '@/contexts/TesterSessionContext';
import { getEnvironmentEndpoints } from '@/constants/environments';
import { splitDisplayName, useTestUsers } from '@/contexts/TestUsersContext';

export default function SettingsScreen() {
  const { userName } = useEncatch();
  const { changeSetup, setupValues } = useTesterSession();
  const { getUser } = useTestUsers();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const endpoints = getEnvironmentEndpoints(setupValues.environment);

  const profile = userName ? getUser(userName) : undefined;
  const { firstName, lastName } = splitDisplayName(profile?.displayName ?? '');

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>Settings</Text>

      {userName ? (
        <View style={styles.profileBox}>
          <Text style={[styles.profileLine, { color: colors.text }]}>
            Username: {userName}
          </Text>
          {(firstName || lastName) && (
            <Text style={[styles.profileLine, { color: colors.tabIconDefault }]}>
              Name: {[firstName, lastName].filter(Boolean).join(' ')}
            </Text>
          )}
          {profile?.email ? (
            <Text style={[styles.profileLine, { color: colors.tabIconDefault }]}>
              Email: {profile.email}
            </Text>
          ) : null}
          <Pressable
            style={({ pressed }) => [styles.linkButton, pressed && styles.buttonPressed]}
            onPress={() =>
              router.push({
                pathname: '/edit-profile',
                params: { username: userName },
              })
            }>
            <Text style={styles.linkButtonText}>Edit profile</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>SDK setup</Text>
        <Text style={[styles.sectionDescription, { color: colors.tabIconDefault }]}>
          Environment: {setupValues.environment.toUpperCase()} ({endpoints.apiBaseUrl})
        </Text>
        <Text style={[styles.sectionDescription, { color: colors.tabIconDefault }]}>
          Clears the saved API key and form id, then returns to the setup screen so you can enter
          new values before sign-in.
        </Text>
        <Pressable
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
          onPress={() => {
            void changeSetup();
          }}>
          <Text style={styles.secondaryButtonText}>Change API key & setup</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.linkButton, pressed && styles.buttonPressed]}
          onPress={() => router.replace('/(auth)/login')}>
          <Text style={styles.linkButtonText}>Go to login screen</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  profileBox: {
    width: '100%',
    marginBottom: 8,
  },
  profileLine: {
    fontSize: 14,
    marginBottom: 4,
  },
  linkButton: {
    alignSelf: 'flex-start',
    marginTop: 12,
  },
  linkButtonText: {
    color: '#3B82F6',
    fontSize: 14,
    fontWeight: '600',
  },
  separator: {
    marginVertical: 28,
    height: 1,
    width: '100%',
  },
  section: {
    width: '100%',
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  sectionDescription: {
    fontSize: 13,
    marginBottom: 16,
  },
  secondaryButton: {
    backgroundColor: '#64748B',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  buttonPressed: {
    opacity: 0.8,
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
