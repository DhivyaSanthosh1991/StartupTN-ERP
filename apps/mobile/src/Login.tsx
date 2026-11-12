import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { errorText } from './api';
import { useSession } from './auth';
import { Button, Notice, s } from './ui';

export function Login() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    setBusy(true);
    setError('');
    try {
      await login(email);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={[s.screen, { justifyContent: 'center' }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={s.pad}>
        <Text style={s.h1}>StartupTN Staff</Text>
        <Text style={[s.body, { marginVertical: 12 }]}>Sign in with your StartupTN email.</Text>
        <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoCorrect={false} placeholder="name@startuptn.in" />
        {error ? <Notice tone="error" text={error} /> : null}
        <Button title="Sign in" onPress={go} busy={busy} disabled={!email.includes('@')} />
        <Text style={s.muted}>The first sign-in may take up to a minute while the server wakes up.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}
