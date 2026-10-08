import React from 'react';
import { SymbolView } from 'expo-symbols';
import { Redirect, Tabs } from 'expo-router';

import Colors from '@/constants/Colors';
import { useColorScheme } from '@/components/useColorScheme';
import { useClientOnlyValue } from '@/components/useClientOnlyValue';
import { useEncatch } from '@encatch/react-native-sdk';
import { useTesterSession } from '@/contexts/TesterSessionContext';
import { TesterHeaderActions } from '@/components/TesterHeaderActions';

function TabsWithEncatch() {
  const colorScheme = useColorScheme();
  const { isInitialized, isIdentified } = useEncatch();

  if (!isInitialized) return null;
  if (!isIdentified) return <Redirect href="/(auth)/login" />;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors[colorScheme].tint,
        headerShown: useClientOnlyValue(false, true),
        headerRight: () => <TesterHeaderActions />,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'house', android: 'home', web: 'home' }}
              tintColor={color}
              size={28}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="events"
        options={{
          title: 'Events',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'hand.tap', android: 'touch_app', web: 'touch_app' }}
              tintColor={color}
              size={28}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
              tintColor={color}
              size={28}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="inline-wildcard"
        options={{
          title: 'Inline (Any)',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'rectangle.inset.filled', android: 'web_asset', web: 'web_asset' }}
              tintColor={color}
              size={28}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="inline-exact"
        options={{
          title: 'Inline (Exact)',
          tabBarIcon: ({ color }) => (
            <SymbolView
              name={{ ios: 'rectangle.badge.checkmark', android: 'fact_check', web: 'fact_check' }}
              tintColor={color}
              size={28}
            />
          ),
        }}
      />
    </Tabs>
  );
}

export default function TabLayout() {
  const { isSdkReady } = useTesterSession();

  if (!isSdkReady) return <Redirect href="/(auth)/login" />;

  return <TabsWithEncatch />;
}
