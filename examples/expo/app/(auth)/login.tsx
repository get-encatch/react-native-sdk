import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useEncatch } from '@encatch/react-native-sdk';
import Colors from '@/constants/Colors';
import { EncatchConfig } from '@/constants/Config';
import {
  ENCATCH_ENVIRONMENTS,
  type EncatchEnvironment,
  getEnvironmentEndpoints,
  MOCK_API_KEY,
  MOCK_FORM_ID,
} from '@/constants/environments';
import { mockSignIdentify, type MockSignature } from '@/constants/mockTools';
import { useColorScheme } from '@/components/useColorScheme';
import { useTesterSession } from '@/contexts/TesterSessionContext';
import {
  buildIdentifyTraits,
  splitDisplayName,
  useTestUsers,
  type StoredTestUser,
} from '@/contexts/TestUsersContext';

function EnvironmentPicker({
  value,
  onChange,
}: {
  value: EncatchEnvironment;
  onChange: (env: EncatchEnvironment) => void;
}) {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const endpoints = getEnvironmentEndpoints(value);

  return (
    <View style={styles.envSection}>
      <Text style={[styles.label, { color: colors.text }]}>Environment</Text>
      <View style={styles.envRow}>
        {ENCATCH_ENVIRONMENTS.map((env) => {
          const selected = env === value;
          return (
            <Pressable
              key={env}
              testID={`env-${env}`}
              style={({ pressed }) => [
                styles.envChip,
                {
                  borderColor: selected ? '#3B82F6' : colors.tabIconDefault,
                  backgroundColor: selected
                    ? colorScheme === 'dark'
                      ? 'rgba(59,130,246,0.2)'
                      : 'rgba(59,130,246,0.1)'
                    : 'transparent',
                },
                pressed && styles.pressed,
              ]}
              onPress={() => onChange(env)}>
              <Text
                style={[
                  styles.envChipText,
                  { color: selected ? '#3B82F6' : colors.text },
                ]}>
                {env.toUpperCase()}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
        API: {endpoints.apiBaseUrl}
      </Text>
      <Text style={[styles.hint, { color: colors.tabIconDefault, marginBottom: 12 }]}>
        Forms: {endpoints.webHost}
      </Text>
    </View>
  );
}

function SetupFields({
  apiKey,
  formId,
  interceptorFormId,
  environment,
  onApiKeyChange,
  onFormIdChange,
  onInterceptorFormIdChange,
  onEnvironmentChange,
}: {
  apiKey: string;
  formId: string;
  interceptorFormId: string;
  environment: EncatchEnvironment;
  onApiKeyChange: (v: string) => void;
  onFormIdChange: (v: string) => void;
  onInterceptorFormIdChange: (v: string) => void;
  onEnvironmentChange: (env: EncatchEnvironment) => void;
}) {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const envApiKeyHint = EncatchConfig.apiKey.trim();
  const envFormIdHint = EncatchConfig.formId.trim();

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>SDK setup</Text>
      <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
        Enter your API key and form id below. Bundled .env values are hints only and are not applied
        until you save.
      </Text>
      <EnvironmentPicker value={environment} onChange={onEnvironmentChange} />
      <Text style={[styles.label, { color: colors.text }]}>API Key</Text>
      <TextInput
        style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
        testID="setup-api-key"
        placeholder={envApiKeyHint ? `Build hint: ${envApiKeyHint}` : 'Enter API key'}
        placeholderTextColor={colors.tabIconDefault}
        value={apiKey}
        onChangeText={onApiKeyChange}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={[styles.label, { color: colors.text }]}>Feedback configuration ID</Text>
      <TextInput
        style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
        testID="setup-form-id"
        placeholder={envFormIdHint ? `Build hint: ${envFormIdHint}` : 'Enter feedback configuration ID'}
        placeholderTextColor={colors.tabIconDefault}
        value={formId}
        onChangeText={onFormIdChange}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={[styles.label, { color: colors.text }]}>Interceptor form ID (optional)</Text>
      <TextInput
        style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
        placeholder="Leave empty to disable"
        placeholderTextColor={colors.tabIconDefault}
        value={interceptorFormId}
        onChangeText={onInterceptorFormIdChange}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function UserRow({
  user,
  selected,
  onPress,
}: {
  user: StoredTestUser;
  selected: boolean;
  onPress: () => void;
}) {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const { firstName, lastName } = splitDisplayName(user.displayName);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.userRow,
        {
          borderColor: selected ? '#3B82F6' : colors.tabIconDefault,
          backgroundColor: selected
            ? colorScheme === 'dark'
              ? 'rgba(59,130,246,0.15)'
              : 'rgba(59,130,246,0.08)'
            : 'transparent',
        },
        pressed && styles.pressed,
      ]}
      onPress={onPress}>
      <Text style={[styles.userName, { color: colors.text }]}>{user.username}</Text>
      {(firstName || lastName) && (
        <Text style={[styles.userMeta, { color: colors.tabIconDefault }]}>
          {[firstName, lastName].filter(Boolean).join(' ')}
        </Text>
      )}
      {user.email ? (
        <Text style={[styles.userMeta, { color: colors.tabIconDefault }]}>{user.email}</Text>
      ) : null}
    </Pressable>
  );
}

function LoginSetupOnly() {
  const { setupValues, updateSetup } = useTesterSession();
  const [apiKey, setApiKey] = useState(setupValues.apiKey);
  const [formId, setFormId] = useState(setupValues.formId);
  const [interceptorFormId, setInterceptorFormId] = useState(setupValues.interceptorFormId);
  const [environment, setEnvironment] = useState(setupValues.environment);
  const [saving, setSaving] = useState(false);
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];

  useEffect(() => {
    setApiKey(setupValues.apiKey);
    setFormId(setupValues.formId);
    setInterceptorFormId(setupValues.interceptorFormId);
    setEnvironment(setupValues.environment);
  }, [setupValues]);

  const canSave = apiKey.trim().length > 0 && formId.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    await updateSetup({
      apiKey: apiKey.trim(),
      formId: formId.trim(),
      interceptorFormId: interceptorFormId.trim(),
      environment,
    });
    setSaving(false);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.text }]}>Encatch SDK Tester</Text>
        <Text style={[styles.subtitle, { color: colors.tabIconDefault }]}>
          Configure the SDK before sign-in. API key and form id are saved on this device.
        </Text>
        <SetupFields
          apiKey={apiKey}
          formId={formId}
          interceptorFormId={interceptorFormId}
          environment={environment}
          onApiKeyChange={setApiKey}
          onFormIdChange={setFormId}
          onInterceptorFormIdChange={setInterceptorFormId}
          onEnvironmentChange={(env) => {
            setEnvironment(env);
            // The local mock API accepts a fixed key and has built-in surveys.
            if (env === 'mock') {
              if (!apiKey.trim()) setApiKey(MOCK_API_KEY);
              if (!formId.trim()) setFormId(MOCK_FORM_ID);
            }
          }}
        />
        <Pressable
          testID="setup-save"
          style={[styles.button, (!canSave || saving) && styles.buttonDisabled]}
          onPress={() => void handleSave()}
          disabled={!canSave || saving}>
          {saving ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Save & continue</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function LoginWithIdentify() {
  const { setupValues, updateSetup, changeSetup } = useTesterSession();
  const { users, isLoading, addUser } = useTestUsers();
  const { identifyUser, isInitialized, trackScreen, trackEvent, showForm } = useEncatch();
  const [visitorValue, setVisitorValue] = useState('/dev-page');
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];

  const [apiKey, setApiKey] = useState(setupValues.apiKey);
  const [formId, setFormId] = useState(setupValues.formId);
  const [interceptorFormId, setInterceptorFormId] = useState(setupValues.interceptorFormId);
  const [environment, setEnvironment] = useState(setupValues.environment);
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  const [showNewUser, setShowNewUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [loading, setLoading] = useState(false);
  const [applyingSetup, setApplyingSetup] = useState(false);
  const [signature, setSignature] = useState<MockSignature>('none');

  useEffect(() => {
    setApiKey(setupValues.apiKey);
    setFormId(setupValues.formId);
    setInterceptorFormId(setupValues.interceptorFormId);
    setEnvironment(setupValues.environment);
  }, [setupValues]);

  const trimmedApiKey = apiKey.trim();
  const trimmedFormId = formId.trim();
  const trimmedInterceptorFormId = interceptorFormId.trim();
  const setupDirty =
    setupValues.apiKey !== trimmedApiKey ||
    setupValues.formId !== trimmedFormId ||
    setupValues.interceptorFormId !== trimmedInterceptorFormId ||
    setupValues.environment !== environment;

  const canApplySetup = trimmedApiKey.length > 0 && trimmedFormId.length > 0 && setupDirty;

  const canIdentify =
    trimmedApiKey.length > 0 &&
    trimmedFormId.length > 0 &&
    !!selectedUsername &&
    isInitialized &&
    !setupDirty;

  const applySetup = useCallback(async () => {
    if (!canApplySetup) return;
    setApplyingSetup(true);
    await updateSetup({
      apiKey: trimmedApiKey,
      formId: trimmedFormId,
      interceptorFormId: trimmedInterceptorFormId,
      environment,
    });
    setApplyingSetup(false);
  }, [
    canApplySetup,
    trimmedApiKey,
    trimmedFormId,
    trimmedInterceptorFormId,
    environment,
    updateSetup,
  ]);

  const handleIdentify = async () => {
    if (!canIdentify || !selectedUsername) return;
    const user = users.find((u) => u.username === selectedUsername);
    if (!user) return;

    setLoading(true);
    if (environment === 'mock' && signature !== 'none') {
      // Secure mode: the mock stands in for the customer's backend that signs the name.
      const secure = await mockSignIdentify(user.username, trimmedApiKey, signature);
      identifyUser(user.username, buildIdentifyTraits(user), { secure });
    } else {
      identifyUser(user.username, buildIdentifyTraits(user));
    }
    setLoading(false);
  };

  const handleCreateUser = async () => {
    const username = newUsername.trim();
    if (!username) return;
    const user: StoredTestUser = {
      username,
      email: newEmail.trim(),
      displayName: newDisplayName.trim(),
    };
    await addUser(user);
    setSelectedUsername(username);
    setShowNewUser(false);
    setNewUsername('');
    setNewEmail('');
    setNewDisplayName('');
  };

  if (!isInitialized || isLoading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#3B82F6" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.text }]}>Encatch SDK Tester</Text>
        <Text style={[styles.subtitle, { color: colors.tabIconDefault }]}>
          Update SDK setup below, then choose a user and identify.
        </Text>

        <SetupFields
          apiKey={apiKey}
          formId={formId}
          interceptorFormId={interceptorFormId}
          environment={environment}
          onApiKeyChange={setApiKey}
          onFormIdChange={setFormId}
          onInterceptorFormIdChange={setInterceptorFormId}
          onEnvironmentChange={(env) => {
            setEnvironment(env);
            // The local mock API accepts a fixed key and has built-in surveys.
            if (env === 'mock') {
              if (!apiKey.trim()) setApiKey(MOCK_API_KEY);
              if (!formId.trim()) setFormId(MOCK_FORM_ID);
            }
          }}
        />

        {setupDirty ? (
          <Text style={[styles.warning, { color: '#B45309' }]}>
            Save setup changes before identifying. The SDK re-initializes when the API key changes.
          </Text>
        ) : null}

        <View style={styles.setupActions}>
          <Pressable
            testID="setup-apply"
            style={({ pressed }) => [
              styles.secondaryButton,
              (!canApplySetup || applyingSetup) && styles.buttonDisabled,
              pressed && styles.pressed,
            ]}
            onPress={() => void applySetup()}
            disabled={!canApplySetup || applyingSetup}>
            {applyingSetup ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.secondaryButtonText}>Apply setup changes</Text>
            )}
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}
            onPress={() => void changeSetup()}>
            <Text style={[styles.link, { color: '#3B82F6' }]}>Change API key & setup</Text>
          </Pressable>
        </View>

        {environment === 'mock' || environment === 'dev' ? (
          // Mock and DEV only: lets the E2E flows drive the SDK as a visitor (not identified yet).
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>SDK checks (visitor)</Text>
            <TextInput
              testID="visitor-value"
              style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
              value={visitorValue}
              onChangeText={setVisitorValue}
              placeholder="/dev-page or dev_event"
              placeholderTextColor={colors.tabIconDefault}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.envRow}>
              <Pressable
                testID="visitor-track-screen"
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                onPress={() => visitorValue.trim() && trackScreen(visitorValue.trim())}>
                <Text style={styles.secondaryButtonText}>Track screen</Text>
              </Pressable>
              <Pressable
                testID="visitor-track-event"
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                onPress={() => visitorValue.trim() && trackEvent(visitorValue.trim())}>
                <Text style={styles.secondaryButtonText}>Track event</Text>
              </Pressable>
              <Pressable
                testID="visitor-show-form"
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                onPress={() => trimmedFormId && showForm(trimmedFormId)}>
                <Text style={styles.secondaryButtonText}>Show form</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Saved users</Text>
          {users.length === 0 ? (
            <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
              No saved users yet. Create one below.
            </Text>
          ) : (
            users.map((user) => (
              <UserRow
                key={user.username}
                user={user}
                selected={selectedUsername === user.username}
                onPress={() => setSelectedUsername(user.username)}
              />
            ))
          )}

          {!showNewUser ? (
            <Pressable
              testID="login-new-user"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
              onPress={() => setShowNewUser(true)}>
              <Text style={styles.secondaryButtonText}>+ New user</Text>
            </Pressable>
          ) : (
            <View style={styles.newUserBox}>
              <Text style={[styles.label, { color: colors.text }]}>Username</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
                testID="login-username"
                placeholder="user_123"
                placeholderTextColor={colors.tabIconDefault}
                value={newUsername}
                onChangeText={setNewUsername}
                autoCapitalize="none"
              />
              <Text style={[styles.label, { color: colors.text }]}>Email</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
                placeholder="user@example.com"
                placeholderTextColor={colors.tabIconDefault}
                value={newEmail}
                onChangeText={setNewEmail}
                autoCapitalize="none"
                keyboardType="email-address"
              />
              <Text style={[styles.label, { color: colors.text }]}>Display name</Text>
              <TextInput
                style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
                placeholder="Test User"
                placeholderTextColor={colors.tabIconDefault}
                value={newDisplayName}
                onChangeText={setNewDisplayName}
              />
              <View style={styles.newUserActions}>
                <Pressable onPress={() => setShowNewUser(false)}>
                  <Text style={[styles.link, { color: colors.tabIconDefault }]}>Cancel</Text>
                </Pressable>
                <Pressable
                  testID="login-save-user"
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    !newUsername.trim() && styles.buttonDisabled,
                    pressed && styles.pressed,
                  ]}
                  onPress={() => void handleCreateUser()}
                  disabled={!newUsername.trim()}>
                  <Text style={styles.secondaryButtonText}>Save user</Text>
                </Pressable>
              </View>
            </View>
          )}
        </View>

        {selectedUsername ? (
          <Pressable
            style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            onPress={() =>
              router.push({
                pathname: '/edit-profile',
                params: { username: selectedUsername },
              })
            }>
            <Text style={[styles.link, { color: '#3B82F6' }]}>Edit profile before sign in</Text>
          </Pressable>
        ) : null}

        {environment === 'mock' ? (
          <View style={styles.section}>
            <Text style={[styles.label, { color: colors.text }]}>Secure mode signature (mock only)</Text>
            <View style={styles.envRow}>
              {(['none', 'valid', 'wrong'] as const).map((kind) => (
                <Pressable
                  key={kind}
                  testID={`login-signature-${kind}`}
                  style={[
                    styles.envChip,
                    { borderColor: signature === kind ? '#3B82F6' : colors.tabIconDefault },
                  ]}
                  onPress={() => setSignature(kind)}>
                  <Text style={[styles.envChipText, { color: signature === kind ? '#3B82F6' : colors.text }]}>
                    {kind}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        <Pressable
          testID="login-identify"
          style={[styles.button, (!canIdentify || loading) && styles.buttonDisabled]}
          onPress={() => void handleIdentify()}
          disabled={!canIdentify || loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Identify user</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export default function LoginScreen() {
  const { isSdkReady } = useTesterSession();
  if (!isSdkReady) {
    return <LoginSetupOnly />;
  }
  return <LoginWithIdentify />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    marginBottom: 16,
  },
  warning: {
    fontSize: 13,
    marginTop: 8,
    marginBottom: 4,
  },
  setupActions: {
    marginTop: 8,
    marginBottom: 8,
    gap: 12,
  },
  linkButton: {
    alignSelf: 'flex-start',
  },
  envSection: {
    marginBottom: 8,
  },
  envRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  envChip: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  envChipText: {
    fontSize: 13,
    fontWeight: '700',
  },
  section: {
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  hint: {
    fontSize: 13,
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    height: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 15,
    marginBottom: 12,
  },
  userRow: {
    borderWidth: 1.5,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  userName: {
    fontSize: 15,
    fontWeight: '600',
  },
  userMeta: {
    fontSize: 12,
    marginTop: 2,
  },
  button: {
    height: 48,
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#64748B',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 8,
  },
  secondaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  newUserBox: {
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(128,128,128,0.3)',
    borderRadius: 8,
  },
  newUserActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  link: {
    fontSize: 14,
    fontWeight: '500',
  },
  linkRow: {
    marginTop: 12,
  },
  pressed: {
    opacity: 0.75,
  },
});
