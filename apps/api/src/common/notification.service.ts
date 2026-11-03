import { Inject, Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { AppConfig, CONFIG } from '../config/config';
import { Db, Queryable } from '../db/db.service';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const MAX_ATTEMPTS = 5;

/**
 * Emails are written to a queue table inside the same transaction as the change that triggers
 * them, so a rolled-back approval never sends mail. A scheduled job (EventBridge → /api/jobs/emails)
 * then sends whatever is queued, and retries failures.
 */
@Injectable()
export class NotificationService {
  private readonly log = new Logger('Email');
  private ses?: SESv2Client;

  constructor(
    private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async queue(mail: OutgoingEmail, q: Queryable = this.db): Promise<void> {
    await q.query(
      'insert into email_outbox (to_address, subject, body_text, body_html) values ($1, $2, $3, $4)',
      [mail.to, mail.subject, mail.text, mail.html ?? null],
    );
  }

  /** Link into the web app. */
  link(path: string): string {
    return `${this.config.webOrigin.replace(/\/$/, '')}${path}`;
  }

  /** Sends up to `limit` queued emails. Safe to run concurrently: rows are claimed with SKIP LOCKED. */
  async flush(limit = 50): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    const batch = await this.db.rows(
      `select id from email_outbox where status = 'queued' order by created_at limit $1`, [limit]);
    for (const { id } of batch) {
      // The row lock is held for the whole send, so two overlapping runs can never mail the same message twice.
      const outcome = await this.db.tx(async (q) => {
        const row = (await q.query(
          `select id, to_address, subject, body_text, body_html, attempts from email_outbox
            where id = $1 and status = 'queued' for update skip locked`, [id])).rows[0];
        if (!row) return 'skipped' as const;
        try {
          await this.send({ to: row.to_address, subject: row.subject, text: row.body_text, html: row.body_html ?? undefined });
          await q.query(`update email_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1 where id = $1`, [id]);
          return 'sent' as const;
        } catch (err) {
          const attempts = row.attempts + 1;
          await q.query(
            `update email_outbox set attempts = $2, last_error = $3, status = $4 where id = $1`,
            [id, attempts, String((err as Error).message).slice(0, 500), attempts >= MAX_ATTEMPTS ? 'failed' : 'queued']);
          return 'failed' as const;
        }
      });
      if (outcome === 'sent') sent++;
      else if (outcome === 'failed') failed++;
    }
    return { sent, failed };
  }

  private async send(mail: OutgoingEmail): Promise<void> {
    if (this.config.emailDriver === 'log') {
      this.log.log(`to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
      return;
    }
    this.ses ??= new SESv2Client({ region: this.config.awsRegion });
    await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: this.config.emailFrom,
        Destination: { ToAddresses: [mail.to] },
        Content: {
          Simple: {
            Subject: { Data: mail.subject },
            Body: { Text: { Data: mail.text }, ...(mail.html ? { Html: { Data: mail.html } } : {}) },
          },
        },
      }),
    );
  }
}
