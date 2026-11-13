import React, { useState } from 'react';
import { Text } from 'react-native';
import { api, errorText } from './api';
import { Button, Card, Err, Field, Page, niceDate, useLoad } from './kit';
import { Sheet, s } from './ui';

interface Item { approvalRequestId: string; typeLabel: string; summary: string; submittedAt: string; requester: { fullName: string; designation: string | null }; stepNumber: number; totalSteps: number }

export function Approvals({ onCount }: { onCount: (n: number) => void }) {
  const inbox = useLoad<Item[]>('/approvals/inbox');
  const [deciding, setDeciding] = useState<{ item: Item; decision: 'approve' | 'reject' } | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => { if (inbox.data) onCount(inbox.data.length); }, [inbox.data, onCount]);

  async function decide() {
    if (!deciding) return;
    if (deciding.decision === 'reject' && comment.trim().length < 3) return setError('Please say why, so the person knows what to change.');
    setBusy(true);
    setError('');
    try {
      await api(`/approvals/${deciding.item.approvalRequestId}/decision`, { method: 'POST', body: { decision: deciding.decision, comment: comment.trim() || undefined } });
      setDeciding(null);
      setComment('');
      await inbox.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Approvals" onRefresh={() => void inbox.reload()} refreshing={inbox.loading}>
      <Err text={inbox.error} />
      {inbox.data && !inbox.data.length ? <Text style={s.muted}>Nothing is waiting for your decision.</Text> : null}
      {(inbox.data ?? []).map((i) => (
        <Card key={i.approvalRequestId}>
          <Text style={[s.body, { fontWeight: '700' }]}>{i.requester.fullName}</Text>
          <Text style={s.muted}>{i.typeLabel}, sent {niceDate(i.submittedAt)}{i.totalSteps > 1 ? `, step ${i.stepNumber} of ${i.totalSteps}` : ''}</Text>
          <Text style={[s.body, { marginVertical: 6 }]}>{i.summary}</Text>
          <Button title="Approve" onPress={() => { setError(''); setDeciding({ item: i, decision: 'approve' }); }} />
          <Button title="Decline" kind="quiet" onPress={() => { setError(''); setDeciding({ item: i, decision: 'reject' }); }} />
        </Card>
      ))}
      <Sheet open={!!deciding} title={deciding?.decision === 'approve' ? `Approve for ${deciding.item.requester.fullName}?` : `Decline for ${deciding?.item.requester.fullName}?`}>
        <Field label={deciding?.decision === 'reject' ? 'Why (required)' : 'Comment (optional)'} value={comment} onChange={setComment} multiline />
        <Err text={error} />
        <Button title={deciding?.decision === 'approve' ? 'Approve' : 'Decline'} kind={deciding?.decision === 'approve' ? 'primary' : 'danger'} onPress={decide} busy={busy} />
        <Button title="Cancel" kind="quiet" onPress={() => { setDeciding(null); setComment(''); setError(''); }} />
      </Sheet>
    </Page>
  );
}
