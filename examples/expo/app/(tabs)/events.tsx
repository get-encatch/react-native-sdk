import { useState } from 'react';
import { StyleSheet, Pressable, ScrollView, TextInput, View } from 'react-native';
import { Text } from '@/components/Themed';
import { useEncatch } from '@encatch/react-native-sdk';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';

const PRESET_EVENTS = [
  { name: 'button_clicked', label: 'Button Clicked' },
  { name: 'feature_used', label: 'Feature Used' },
  { name: 'purchase_started', label: 'Purchase Started' },
  { name: 'survey_viewed', label: 'Survey Viewed' },
  { name: 'home_viewed', label: 'Home Viewed' },
];

const PRESET_SCREENS = [
  { name: '/home', label: 'Home' },
  { name: '/dashboard', label: 'Dashboard' },
  { name: '/settings', label: 'Settings' },
  { name: '/dashboard/encatch-test', label: 'Encatch test' },
];

export default function EventsScreen() {
  const { trackEvent, trackScreen } = useEncatch();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const [customEvent, setCustomEvent] = useState('test_event');
  const [customScreen, setCustomScreen] = useState('/dashboard/encatch-test');

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>trackEvent & trackScreen</Text>
      <Text style={[styles.subtitle, { color: colors.tabIconDefault }]}>
        Fire preset or custom events and screen views.
      </Text>

      <View style={[styles.card, { borderColor: colors.tabIconDefault }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Preset events</Text>
        {PRESET_EVENTS.map(({ name, label }) => (
          <Pressable
            key={name}
            style={({ pressed }) => [styles.presetButton, pressed && styles.pressed]}
            onPress={() => trackEvent(name)}>
            <Text style={styles.presetButtonText}>{label}</Text>
          </Pressable>
        ))}

        <Text style={[styles.fieldLabel, { color: colors.text }]}>Custom event</Text>
        <View style={styles.row}>
          <TextInput
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.tabIconDefault, flex: 1 },
            ]}
            value={customEvent}
            onChangeText={setCustomEvent}
            placeholder="test_event"
            placeholderTextColor={colors.tabIconDefault}
            autoCapitalize="none"
          />
          <Pressable
            style={({ pressed }) => [
              styles.actionButton,
              !customEvent.trim() && styles.disabled,
              pressed && styles.pressed,
            ]}
            onPress={() => customEvent.trim() && trackEvent(customEvent.trim())}
            disabled={!customEvent.trim()}>
            <Text style={styles.actionButtonText}>Fire</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.card, { borderColor: colors.tabIconDefault }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Preset screens</Text>
        {PRESET_SCREENS.map(({ name, label }) => (
          <Pressable
            key={name}
            style={({ pressed }) => [styles.presetButton, pressed && styles.pressed]}
            onPress={() => trackScreen(name)}>
            <Text style={styles.presetButtonText}>{label}</Text>
            <Text style={styles.presetMeta}>{name}</Text>
          </Pressable>
        ))}

        <Text style={[styles.fieldLabel, { color: colors.text }]}>Custom screen</Text>
        <View style={styles.row}>
          <TextInput
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.tabIconDefault, flex: 1 },
            ]}
            value={customScreen}
            onChangeText={setCustomScreen}
            placeholder="/dashboard/encatch-test"
            placeholderTextColor={colors.tabIconDefault}
            autoCapitalize="none"
          />
          <Pressable
            style={({ pressed }) => [
              styles.actionButton,
              !customScreen.trim() && styles.disabled,
              pressed && styles.pressed,
            ]}
            onPress={() => customScreen.trim() && trackScreen(customScreen.trim())}
            disabled={!customScreen.trim()}>
            <Text style={styles.actionButtonText}>Track</Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 4,
    marginBottom: 20,
  },
  card: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 16,
    marginBottom: 20,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  presetButton: {
    backgroundColor: '#3B82F6',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginBottom: 8,
  },
  presetButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  presetMeta: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 11,
    marginTop: 2,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    height: 44,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  actionButton: {
    backgroundColor: '#10B981',
    borderRadius: 8,
    paddingHorizontal: 14,
    height: 44,
    justifyContent: 'center',
  },
  actionButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  pressed: {
    opacity: 0.8,
  },
  disabled: {
    opacity: 0.5,
  },
});
