import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

export const colors = { ink: '#14302f', peacock: '#0f6b66', soft: '#e8f1f0', line: '#cfdcdb', warn: '#b45309', bad: '#b42318', bg: '#f7faf9', white: '#fff' };

export function Button({ title, onPress, busy, kind = 'primary', disabled }: { title: string; onPress: () => void; busy?: boolean; kind?: 'primary' | 'quiet' | 'danger'; disabled?: boolean }) {
  const bg = kind === 'primary' ? colors.peacock : kind === 'danger' ? colors.bad : colors.soft;
  const fg = kind === 'quiet' ? colors.ink : colors.white;
  return (
    <Pressable onPress={onPress} disabled={busy || disabled} style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: busy || disabled ? 0.55 : pressed ? 0.85 : 1 }]}>
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Notice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'error' | 'ok' }) {
  const c = tone === 'error' ? colors.bad : tone === 'ok' ? colors.peacock : colors.warn;
  return <Text style={[s.notice, { color: c, borderColor: c }]}>{text}</Text>;
}

export function Sheet({ open, title, children }: { open: boolean; title: string; children: React.ReactNode }) {
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={() => {}}>
      <View style={s.scrim}>
        <View style={s.sheet}>
          <Text style={s.sheetTitle}>{title}</Text>
          {children}
        </View>
      </View>
    </Modal>
  );
}

export const s = StyleSheet.create({
  btn: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, marginVertical: 6 },
  btnText: { fontSize: 16, fontWeight: '600' },
  notice: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4, marginVertical: 8, fontSize: 14, lineHeight: 20 },
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.white, padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%' },
  sheetTitle: { fontSize: 19, fontWeight: '700', color: colors.ink, marginBottom: 10 },
  screen: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: 20 },
  h1: { fontSize: 26, fontWeight: '700', color: colors.ink },
  body: { fontSize: 15, color: colors.ink, lineHeight: 22 },
  muted: { fontSize: 13, color: '#5b7270' },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 12, fontSize: 16, backgroundColor: colors.white, color: colors.ink },
});
