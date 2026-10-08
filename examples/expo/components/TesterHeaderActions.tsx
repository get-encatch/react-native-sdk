import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/Themed';
import { useEncatch, Encatch } from '@encatch/react-native-sdk';
import type { Theme } from '@encatch/react-native-sdk';
import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';

const THEME_CYCLE: Theme[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<Theme, string> = {
  system: 'Sys',
  light: 'Light',
  dark: 'Dark',
};

export function TesterHeaderActions() {
  const { resetUser, setTheme } = useEncatch();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const [theme, setLocalTheme] = useState<Theme>(Encatch.theme);

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    setLocalTheme(next);
    setTheme(next);
  };

  const handleLogout = () => {
    resetUser();
    router.replace('/(auth)/login');
  };

  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [
          styles.chip,
          { borderColor: colors.tabIconDefault },
          pressed && styles.pressed,
        ]}
        onPress={cycleTheme}
        accessibilityLabel="Cycle theme">
        <Text style={[styles.chipText, { color: colors.text }]}>{THEME_LABEL[theme]}</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.logout, pressed && styles.pressed]}
        onPress={handleLogout}
        accessibilityLabel="Logout">
        <Text style={styles.logoutText}>Logout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 8,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  logout: {
    backgroundColor: '#EF4444',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  logoutText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.75,
  },
});
