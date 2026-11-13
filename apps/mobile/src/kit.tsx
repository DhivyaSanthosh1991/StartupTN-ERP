import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { api, errorText } from './api';
import { Button, Notice, colors, s } from './ui';

export const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const niceDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
export const validTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Loads a path and reloads on pull-down. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(path !== null);
  const reload = useCallback(async () => {
    if (path === null) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

export function Page({ title, children, onRefresh, refreshing }: { title: string; children: React.ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}>
      <Text style={[s.h1, { marginBottom: 12 }]}>{title}</Text>
      {children}
    </ScrollView>
  );
}

export function Card({ children }: { children: React.ReactNode }) {
  return <View style={{ backgroundColor: colors.white, borderRadius: 14, padding: 14, marginVertical: 6, borderWidth: 1, borderColor: colors.line }}>{children}</View>;
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <Text style={[s.body, { fontWeight: '700', marginTop: 16, marginBottom: 4 }]}>{children}</Text>;
}

export function Field({ label, value, onChange, placeholder, multiline, keyboard }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean; keyboard?: 'default' | 'numeric' }) {
  return (
    <View style={{ marginVertical: 6 }}>
      <Text style={s.muted}>{label}</Text>
      <TextInput style={[s.input, multiline ? { minHeight: 70, textAlignVertical: 'top' } : null]} value={value} onChangeText={onChange} placeholder={placeholder}
        multiline={multiline} keyboardType={keyboard ?? 'default'} autoCapitalize="none" />
    </View>
  );
}

export function Chips<T extends string>({ label, options, value, onChange }: { label?: string; options: { value: T; label: string }[]; value: T | ''; onChange: (v: T) => void }) {
  return (
    <View style={{ marginVertical: 6 }}>
      {label ? <Text style={s.muted}>{label}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
        {options.map((o) => (
          <Pressable key={o.value} onPress={() => onChange(o.value)}
            style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: value === o.value ? colors.peacock : colors.line, backgroundColor: value === o.value ? colors.peacock : colors.white }}>
            <Text style={{ color: value === o.value ? colors.white : colors.ink, fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const STATUS: Record<string, string> = { pending: 'Waiting for approval', approved: 'Approved', rejected: 'Declined', cancelled: 'Cancelled' };
export const statusText = (st: string) => STATUS[st] ?? st;

export function Err({ text }: { text: string }) {
  return text ? <Notice tone="error" text={text} /> : null;
}

export { Button };
