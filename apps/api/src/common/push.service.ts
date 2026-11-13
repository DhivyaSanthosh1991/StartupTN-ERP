import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/config';
import { Db } from '../db/db.service';

export interface PushMessage { title: string; body: string; data?: Record<string, unknown> }

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Sends a notification to every phone a person has the app on. Delivery goes through Expo's push service,
 * which hands it to Google (Android) or Apple. A failure here never stops the caller: a missed
 * notification is a nuisance, a failed punch would be a problem.
 * With PUSH_DRIVER=log (tests, local runs) messages are only kept in `sent`.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  readonly sent: (PushMessage & { employeeId: string })[] = [];

  constructor(private readonly db: Db, @Inject(CONFIG) private readonly config: AppConfig) {}

  async toEmployee(employeeId: string, msg: PushMessage): Promise<number> {
    try {
      const tokens: string[] = (await this.db.rows('select push_token from devices where employee_id = $1', [employeeId])).map((r) => r.push_token);
      if (!tokens.length) return 0;
      if (this.config.pushDriver === 'log') {
        this.sent.push({ ...msg, employeeId });
        return tokens.length;
      }
      const res = await fetch(EXPO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(tokens.map((to) => ({ to, title: msg.title, body: msg.body, data: msg.data ?? {}, sound: 'default', priority: 'high', channelId: 'alerts' }))),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => null)) as { data?: { status: string; details?: { error?: string } }[] } | null;
      // Phones that uninstalled the app are forgotten so they are not tried again.
      const dead = (json?.data ?? []).flatMap((r, i) => (r.status === 'error' && r.details?.error === 'DeviceNotRegistered' ? [tokens[i]] : []));
      if (dead.length) await this.db.query('delete from devices where push_token = any($1)', [dead]);
      if (!res.ok) this.log.warn(`Expo push answered ${res.status}`);
      return tokens.length - dead.length;
    } catch (e) {
      this.log.warn(`Push failed: ${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }
}
