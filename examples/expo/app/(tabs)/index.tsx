import { StyleSheet, Pressable, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Text, View } from '@/components/Themed';
import { FormIdPicker } from '@/components/FormIdPicker';
import { useEncatch } from '@encatch/react-native-sdk';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useActiveFormId } from '@/hooks/useActiveFormId';
import { useTesterConfig } from '@/contexts/TesterConfigContext';
import { splitDisplayName, useTestUsers } from '@/contexts/TestUsersContext';

export default function HomeScreen() {
  const { trackEvent, showForm, addToResponse, userName } = useEncatch();
  const { getUser } = useTestUsers();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const { interceptorFormId, setFormId } = useTesterConfig();
  const profile = userName ? getUser(userName) : undefined;
  const { firstName, lastName } = splitDisplayName(profile?.displayName ?? '');
  const {
    suggestedIds,
    manualFormId,
    setManualFormId,
    selectedFormId,
    setSelectedFormId,
    activeFormId,
  } = useActiveFormId();

  const handleFormIdChange = (next: string) => {
    if (suggestedIds.length > 1) {
      setSelectedFormId(next);
    } else {
      setManualFormId(next);
    }
    setFormId(next);
  };

  const formPickerValue = suggestedIds.length > 1 ? selectedFormId : manualFormId;

  return (
    <ScrollView
      style={[styles.scroll, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>Home</Text>
      {userName && (
        <View style={styles.userBlock}>
          <Text style={[styles.subtitle, { color: colors.tabIconDefault }]}>
            {userName}
            {(firstName || lastName) ? ` · ${[firstName, lastName].filter(Boolean).join(' ')}` : ''}
          </Text>
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/edit-profile',
                params: { username: userName },
              })
            }>
            <Text style={styles.editLink}>Edit profile</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      <Text style={[styles.sectionTitle, { color: colors.text }]}>Show Form</Text>
      <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
        Enter a feedback configuration ID or pick from env defaults.
      </Text>
      <FormIdPicker
        formIds={suggestedIds}
        value={formPickerValue}
        onChange={handleFormIdChange}
        textColor={colors.text}
        borderColor={colors.tabIconDefault}
        placeholderColor={colors.tabIconDefault}
      />
      <Pressable
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          !activeFormId && styles.buttonDisabled,
        ]}
        onPress={() => activeFormId && showForm(activeFormId)}
        disabled={!activeFormId}>
        <Text style={styles.buttonText}>Show Form</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.button,
          styles.buttonSecondary,
          pressed && styles.buttonPressed,
          !activeFormId && styles.buttonDisabled,
        ]}
        onPress={() => {
          if (activeFormId) {
            addToResponse('0196fc1f-87f3-7968-b942-7dd762786d57', 'hello');
            showForm(activeFormId);
          }
        }}
        disabled={!activeFormId}>
        <Text style={styles.buttonText}>Show Form (prefilled)</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.button,
          styles.buttonTertiary,
          pressed && styles.buttonPressed,
          !interceptorFormId && styles.buttonDisabled,
        ]}
        onPress={() => interceptorFormId && showForm(interceptorFormId)}
        disabled={!interceptorFormId}>
        <Text style={styles.buttonText}>Show Form (interceptor test)</Text>
      </Pressable>
      {!interceptorFormId ? (
        <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
          Set an interceptor test form ID on the setup screen to enable the button above.
        </Text>
      ) : null}

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={() => trackEvent('home_viewed')}>
        <Text style={styles.buttonText}>Track Event: home_viewed</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  userBlock: {
    alignItems: 'center',
    marginTop: 4,
  },
  editLink: {
    color: '#3B82F6',
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
    alignSelf: 'stretch',
  },
  hint: {
    fontSize: 12,
    marginTop: 4,
    marginBottom: 12,
    alignSelf: 'stretch',
  },
  separator: {
    marginVertical: 30,
    height: 1,
    width: '80%',
  },
  button: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 8,
    width: '100%',
    alignItems: 'center',
  },
  buttonSecondary: {
    backgroundColor: '#10B981',
  },
  buttonTertiary: {
    backgroundColor: '#F59E0B',
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
