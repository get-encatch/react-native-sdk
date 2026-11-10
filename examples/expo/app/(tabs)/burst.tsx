/**
 * Burst tests: fire the call patterns seen in production in one go and watch how
 * many requests reach the API. Only works against the local mock API
 * (examples/mock-api) — never against dev, UAT or production.
 *
 * Counters come from the mock's /__mock/stats, so no SDK change is needed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useEncatch } from '@encatch/react-native-sdk';
import { Text } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { MOCK_API_URL, MOCK_FORM_ID } from '@/constants/environments';
import { useTesterSession } from '@/contexts/TesterSessionContext';

type Stats = {
  total: number;
  byEndpoint: Record<string, { total: number; byStatus: Record<string, number> }>;
};

const PRESETS = ['off', 'per-endpoint-5', 'planned-prod', 'report', 'code-defaults-test'] as const;
const LATENCIES = [0, 50, 300] as const;
const STATUSES = ['200', '401', '403', '404', '429'] as const;
const ENDPOINT_ORDER = ['identify-user', 'track-event', 'track-screen', 'ping', 'show-form', 'submit-form', 'dismiss-form'];
const SURVEY_SCREEN = '/burst-survey';

async function mock(path: string, body?: unknown) {
  const res = await fetch(`${MOCK_API_URL}/__mock/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

export default function BurstScreen() {
  const { setupValues } = useTesterSession();
  const { identifyUser, trackEvent, trackScreen, resetUser, userName } = useEncatch();
  const colors = Colors[useColorScheme()];
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<string>('off');
  const [latency, setLatency] = useState<number>(50);
  const [lastRun, setLastRun] = useState<string>('');
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMock = setupValues.environment === 'mock';

  const refresh = useCallback(async () => {
    try {
      setStats(await mock('stats'));
      setError(null);
    } catch (e) {
      setError(`Can't reach the mock API at ${MOCK_API_URL}. Start it with: pnpm --filter @encatch/mock-api dev`);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!isMock) return undefined;
      refresh();
      polling.current = setInterval(refresh, 1000);
      return () => {
        if (polling.current) clearInterval(polling.current);
      };
    }, [isMock, refresh])
  );

  useEffect(() => {
    if (!isMock) return;
    mock('scenario')
      .then((s) => setLatency(s.latencyMs ?? 50))
      .catch(() => {});
  }, [isMock]);

  if (!isMock) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={[styles.title, { color: colors.text }]}>Burst tests</Text>
        <Text style={{ color: colors.text }}>
          Burst tests only run against the Mock environment, never dev, UAT or production. Choose MOCK on the setup
          screen to use them.
        </Text>
      </View>
    );
  }

  const run = (label: string, fn: () => void) => () => {
    setLastRun(label);
    fn();
  };
  const name = userName ?? 'burst-user';

  const BURSTS: Array<{ id: string; label: string; fn: () => void | Promise<void> }> = [
    { id: 'burst-identify-same', label: '20 × identical identifyUser', fn: () => { for (let i = 0; i < 20; i++) identifyUser(name, { $set: { plan: 'pro' } }); } },
    { id: 'burst-event-same', label: '20 × identical trackEvent', fn: () => { for (let i = 0; i < 20; i++) trackEvent('burst_event'); } },
    { id: 'burst-event-different', label: '20 × different trackEvent', fn: () => { for (let i = 0; i < 20; i++) trackEvent(`burst_event_${i}`); } },
    { id: 'burst-screen-same', label: '20 × identical trackScreen', fn: () => { for (let i = 0; i < 20; i++) trackScreen('/burst'); } },
    {
      id: 'burst-survey-screen',
      label: '18 × trackScreen on a screen with a survey',
      fn: async () => {
        await mock('scenario', { triggers: { screens: { [SURVEY_SCREEN]: { formId: MOCK_FORM_ID, onPageDelay: 0 } } } });
        for (let i = 0; i < 18; i++) trackScreen(SURVEY_SCREEN);
      },
    },
    { id: 'burst-reset-identify', label: 'resetUser() then identifyUser(), not awaited', fn: () => { resetUser(); identifyUser(name); } },
  ];

  const endpoints = stats
    ? [...ENDPOINT_ORDER.filter((e) => stats.byEndpoint[e]), ...Object.keys(stats.byEndpoint).filter((e) => !ENDPOINT_ORDER.includes(e))]
    : [];

  return (
    <ScrollView style={{ backgroundColor: colors.background }} contentContainerStyle={styles.container}>
      <Text style={[styles.title, { color: colors.text }]}>Burst tests</Text>
      <Text style={[styles.subtitle, { color: colors.tabIconDefault }]}>Mock API: {MOCK_API_URL}</Text>
      {error ? <Text style={styles.error} testID="burst-error">{error}</Text> : null}

      <View style={[styles.card, { borderColor: colors.tabIconDefault }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Bursts</Text>
        {BURSTS.map((b) => (
          <Pressable
            key={b.id}
            testID={b.id}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            onPress={run(b.label, () => void b.fn())}>
            <Text style={styles.buttonText}>{b.label}</Text>
          </Pressable>
        ))}
        {lastRun ? <Text style={{ color: colors.tabIconDefault }} testID="burst-last-run">Last run: {lastRun}</Text> : null}
      </View>

      <View style={[styles.card, { borderColor: colors.tabIconDefault }]}>
        <View style={styles.rowBetween}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Requests received by the mock</Text>
          <Pressable
            testID="burst-reset-counters"
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
            onPress={async () => {
              await mock('reset?keepScenario=1', {});
              setLastRun('');
              refresh();
            }}>
            <Text style={styles.buttonText}>Reset</Text>
          </Pressable>
        </View>
        <View style={styles.tableRow}>
          <Text style={[styles.cellWide, styles.head, { color: colors.text }]}>Endpoint</Text>
          <Text style={[styles.cell, styles.head, { color: colors.text }]}>All</Text>
          {STATUSES.map((s) => (
            <Text key={s} style={[styles.cell, styles.head, { color: colors.text }]}>{s}</Text>
          ))}
        </View>
        {endpoints.map((ep) => (
          <View key={ep} style={styles.tableRow} testID={`burst-row-${ep}`}>
            <Text style={[styles.cellWide, { color: colors.text }]}>{ep}</Text>
            <Text style={[styles.cell, { color: colors.text }]} testID={`burst-count-${ep}`}>
              {stats!.byEndpoint[ep].total}
            </Text>
            {STATUSES.map((s) => (
              <Text key={s} style={[styles.cell, { color: colors.text }]} testID={`burst-count-${ep}-${s}`}>
                {stats!.byEndpoint[ep].byStatus[s] ?? 0}
              </Text>
            ))}
          </View>
        ))}
        <Text style={{ color: colors.text }} testID="burst-total">Total: {stats?.total ?? 0}</Text>
      </View>

      <View style={[styles.card, { borderColor: colors.tabIconDefault }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Mock rate limits</Text>
        <View style={styles.chips}>
          {PRESETS.map((p) => (
            <Pressable
              key={p}
              testID={`burst-preset-${p}`}
              style={[styles.chip, { borderColor: p === preset ? '#3B82F6' : colors.tabIconDefault }]}
              onPress={async () => {
                await mock('scenario', { preset: p });
                setPreset(p);
              }}>
              <Text style={{ color: p === preset ? '#3B82F6' : colors.text }}>{p}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Mock latency</Text>
        <View style={styles.chips}>
          {LATENCIES.map((ms) => (
            <Pressable
              key={ms}
              testID={`burst-latency-${ms}`}
              style={[styles.chip, { borderColor: ms === latency ? '#3B82F6' : colors.tabIconDefault }]}
              onPress={async () => {
                await mock('scenario', { latencyMs: ms });
                setLatency(ms);
              }}>
              <Text style={{ color: ms === latency ? '#3B82F6' : colors.text }}>{ms} ms</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 13 },
  error: { color: '#DC2626' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  button: { backgroundColor: '#3B82F6', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  smallButton: { backgroundColor: '#6B7280', borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  buttonText: { color: '#fff', fontWeight: '600' },
  pressed: { opacity: 0.7 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tableRow: { flexDirection: 'row', alignItems: 'center' },
  head: { fontWeight: '700' },
  cellWide: { flex: 3, fontSize: 12 },
  cell: { flex: 1, fontSize: 12, textAlign: 'right' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 16, paddingVertical: 4, paddingHorizontal: 10 },
});
