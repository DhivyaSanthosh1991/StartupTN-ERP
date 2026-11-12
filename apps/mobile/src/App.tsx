import React from 'react';
import { ActivityIndicator, Platform, SafeAreaView, StatusBar as RNStatusBar, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { SessionProvider, useSession } from './auth';
import { Home } from './Home';
import { Login } from './Login';
import { colors, s } from './ui';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

function Root() {
  const { user, ready } = useSession();
  if (!ready) return <View style={[s.screen, { justifyContent: 'center' }]}><ActivityIndicator color={colors.peacock} /></View>;
  return user ? <Home /> : <Login />;
}

export default function App() {
  return (
    <SessionProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 24 : 0 }}>
        <StatusBar style="dark" />
        <Root />
      </SafeAreaView>
    </SessionProvider>
  );
}
