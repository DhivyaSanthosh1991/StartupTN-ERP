import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, SafeAreaView, StatusBar as RNStatusBar, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SessionProvider, useSession } from './auth';
import { Approvals } from './Approvals';
import { Duty } from './Duty';
import { Home } from './Home';
import { Leave } from './Leave';
import { Login } from './Login';
import { colors, s } from './ui';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

type Tab = 'today' | 'leave' | 'duty' | 'approvals';
const TABS: { id: Tab; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'leave', label: 'Leave' },
  { id: 'duty', label: 'On duty' },
  { id: 'approvals', label: 'Approvals' },
];

function Shell() {
  const [tab, setTab] = useState<Tab>('today');
  const [waiting, setWaiting] = useState(0);
  const onCount = useCallback((n: number) => setWaiting(n), []);

  // The approvals list loads once in the background so the tab can show how many are waiting.
  useEffect(() => {
    // tapping a notification brings the person to the screen that needs them
    const sub = Notifications.addNotificationResponseReceivedListener(() => setTab('today'));
    return () => sub.remove();
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1, display: tab === 'today' ? 'flex' : 'none' }}><Home /></View>
        <View style={{ flex: 1, display: tab === 'leave' ? 'flex' : 'none' }}><Leave /></View>
        <View style={{ flex: 1, display: tab === 'duty' ? 'flex' : 'none' }}><Duty /></View>
        <View style={{ flex: 1, display: tab === 'approvals' ? 'flex' : 'none' }}><Approvals onCount={onCount} /></View>
      </View>
      <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white }}>
        {TABS.map((t) => (
          <Pressable key={t.id} onPress={() => setTab(t.id)} style={{ flex: 1, alignItems: 'center', paddingVertical: 14 }}>
            <Text style={{ fontSize: 13, fontWeight: tab === t.id ? '700' : '400', color: tab === t.id ? colors.peacock : '#5b7270' }}>
              {t.label}{t.id === 'approvals' && waiting ? ` (${waiting})` : ''}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Root() {
  const { user, ready } = useSession();
  if (!ready) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={colors.peacock} /></View>;
  return user ? <Shell /> : <Login />;
}

export default function App() {
  useEffect(() => {
    // a loud channel, so the presence question and away alert are not silenced as "minor" notifications
    if (Platform.OS === 'android') {
      void Notifications.setNotificationChannelAsync('alerts', { name: 'Attendance alerts', importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 300, 200, 300] });
    }
  }, []);
  return (
    <SessionProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 24 : 0 }}>
        <StatusBar style="dark" />
        <Root />
      </SafeAreaView>
    </SessionProvider>
  );
}
