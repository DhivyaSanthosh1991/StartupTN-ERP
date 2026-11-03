'use client';

import { useState } from 'react';
import { api, errorText, useApi } from '@/lib/api';
import { addMonths, todayIst, fmtClock, fmtDay, fmtMinutes, monthBounds, monthLabel } from '@/lib/dates';
import { ATTENTION_FLAGS, dayStatusOf, flagLabel } from '@/lib/labels';
import type { DayStatus, MonthDay, MonthSummary, PunchEvent } from '@/lib/types';
import { Icon } from './icons';
import { SelfieThumb } from './selfie';
import { Badge, Button, Dialog, ErrorNote, Loading, Panel, cx } from './ui';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CELL_TONE: Record<DayStatus, string> = {
  present: 'bg-peacock-tint text-peacock-dark',
  half_day: 'bg-marigold-tint text-marigold-ink',
  absent: 'bg-kumkum-tint text-kumkum',
  leave: 'bg-indigo-tint text-indigo',
  od: 'bg-indigo-tint text-indigo',
  holiday: 'bg-wash text-muted',
  weekly_off: 'bg-transparent text-muted',
  incomplete: 'bg-marigold-tint text-marigold-ink',
};

interface TrailEvent extends PunchEvent { distanceM: number | null; note: string | null }

/**
 * One person's month, laid out as a calendar. Each day carries a word as well as a colour.
 * Opening a day shows the punches behind it, with locations for people allowed to see them.
 */
export function MonthCalendar({ employeeId, month, onMonth, onCorrect }: {
  employeeId?: string; month: string; onMonth: (m: string) => void; onCorrect?: (date: string) => void;
}) {
  const path = employeeId ? `/attendance/employees/${employeeId}?month=${month}` : `/attendance/me?month=${month}`;
  const { data, error, loading, reload } = useApi<{ days: MonthDay[]; summary: MonthSummary }>(path);
  const [open, setOpen] = useState<MonthDay | null>(null);
  const [trail, setTrail] = useState<TrailEvent[] | null>(null);
  const [trailError, setTrailError] = useState('');

  async function show(day: MonthDay) {
    setOpen(day);
    setTrail(null);
    setTrailError('');
    try {
      const q = new URLSearchParams({ date: day.date });
      if (employeeId) q.set('employeeId', employeeId);
      setTrail(await api<TrailEvent[]>(`/attendance/trail?${q}`));
    } catch (e) {
      setTrailError(errorText(e));
    }
  }

  const [first] = monthBounds(month);
  const lead = data ? new Date(`${first}T00:00:00Z`).getUTCDay() : 0;
  const s = data?.summary;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">{monthLabel(month)}</h2>
        <div className="flex gap-1">
          <button type="button" onClick={() => onMonth(addMonths(month, -1))} aria-label="Previous month" className="rounded-lg border border-line p-2 hover:bg-wash"><Icon name="left" className="size-4" /></button>
          <button type="button" onClick={() => onMonth(addMonths(month, 1))} aria-label="Next month" className="rounded-lg border border-line p-2 hover:bg-wash"><Icon name="right" className="size-4" /></button>
        </div>
      </div>

      {error && <ErrorNote error={error} retry={reload} />}
      {loading && !data && <Loading />}

      {data && s && (
        <>
          <dl className="mb-4 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-6">
            {[
              ['Present', s.present + s.halfDay * 0.5], ['Absent', s.absent], ['Leave', s.leave], ['On duty', s.od], ['Late', s.late], ['Hours', fmtMinutes(s.workedMinutes)],
            ].map(([k, v]) => (
              <div key={k as string} className="bg-surface px-3 py-2.5">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="font-display text-xl font-semibold">{v}</dd>
              </div>
            ))}
          </dl>

          <Panel className={cx('overflow-hidden', loading && 'opacity-60')}>
            <div className="grid grid-cols-7 border-b border-line bg-wash/60 text-center text-xs font-medium text-muted">
              {WEEKDAYS.map((d) => <div key={d} className="py-2">{d}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: lead }).map((_, i) => <div key={`pad${i}`} className="min-h-16 border-b border-r border-line/60 bg-wash/30 sm:min-h-20" />)}
              {data.days.map((d) => {
                const st = d.status ? dayStatusOf(d.status, d.flags) : null;
                const flagged = d.flags.some((f) => ATTENTION_FLAGS.has(f));
                return (
                  <button key={d.date} type="button" onClick={() => void show(d)}
                    aria-label={`${fmtDay(d.date)}: ${st?.label ?? 'nothing recorded'}${d.holiday ? `, ${d.holiday}` : ''}`}
                    className="relative min-h-16 border-b border-r border-line/60 p-1 text-left hover:bg-wash/60 sm:min-h-20 sm:p-1.5">
                    <span className="text-xs font-medium text-muted">{Number(d.date.slice(8))}</span>
                    {st && (
                      <span className={cx('mt-1 block truncate rounded px-1 py-0.5 text-center text-[11px] font-semibold sm:text-xs', CELL_TONE[d.status!])}>
                        <span className="sm:hidden">{st.short}</span><span className="hidden sm:inline">{st.label}</span>
                      </span>
                    )}
                    {d.firstIn && <span className="mt-0.5 hidden text-[11px] text-muted sm:block">{fmtClock(d.firstIn)}</span>}
                    {(d.late || flagged) && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-marigold" aria-hidden="true" />}
                  </button>
                );
              })}
            </div>
          </Panel>
          <p className="mt-2 text-xs text-muted">An orange dot marks a late arrival or something worth checking. Tap a day for the details.</p>
        </>
      )}

      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? fmtDay(open.date) : ''}>
        {open && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              {open.status ? <Badge tone={dayStatusOf(open.status, open.flags).tone}>{dayStatusOf(open.status, open.flags).label}</Badge> : <Badge>Nothing recorded</Badge>}
              {open.holiday && <Badge>{open.holiday}</Badge>}
              {open.late && <Badge tone="marigold">Late</Badge>}
              {open.flags.filter((f) => !(f === 'missing_checkout' && open.status === 'incomplete')).map((f) => <Badge key={f} tone={ATTENTION_FLAGS.has(f) ? 'marigold' : 'neutral'}>{flagLabel(f)}</Badge>)}
            </div>
            {open.firstIn && (
              <p className="text-muted">
                First in {fmtClock(open.firstIn)}{open.lastOut ? `, last out ${fmtClock(open.lastOut)}` : ', not checked out'}. Worked {fmtMinutes(open.workedMinutes)}.
              </p>
            )}
            {trailError && <p className="text-kumkum">{trailError}</p>}
            {!trail && !trailError && <Loading />}
            {trail && trail.length === 0 && <p className="text-muted">No check-ins or check-outs on this day.</p>}
            {trail && trail.length > 0 && (
              <ol className="divide-y divide-line rounded-lg border border-line">
                {trail.map((e) => (
                  <li key={e.id} className={cx('flex items-start gap-3 px-3 py-2.5', e.flags.includes('superseded') && 'opacity-55')}>
                    <SelfieThumb event={e} label={`${e.type === 'check_in' ? 'checked in' : 'checked out'} at ${fmtClock(e.at)}`} />
                    <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{fmtClock(e.at)}</span>
                      <span>{e.type === 'check_in' ? 'Checked in' : 'Checked out'}</span>
                      {e.flags.includes('superseded') && <Badge>Replaced by a correction</Badge>}
                    </p>
                    <p className="mt-0.5 text-muted">
                      {e.source === 'regularisation' ? 'Added by an approved correction'
                        : e.source === 'biometric' ? 'Biometric machine, head office'
                        : e.latitude === null ? 'No location'
                        : `${e.geofenceName ? (e.withinGeofence ? `At ${e.geofenceName}` : `${e.distanceM !== null ? `${e.distanceM >= 1000 ? `${(e.distanceM / 1000).toFixed(1)} km` : `${e.distanceM} m`} from ` : 'Away from '}${e.geofenceName}`) : 'Outside the office area'}${e.accuracyM !== null ? `, GPS ±${Math.round(e.accuracyM)} m` : ''}`}
                    </p>
                    {e.note && <p className="mt-0.5 text-muted">Note: {e.note}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {onCorrect && open.date <= todayIst() && (
              <div className="flex justify-end"><Button variant="secondary" onClick={() => { const d = open.date; setOpen(null); onCorrect(d); }}>Ask for a correction</Button></div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
