import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';
import { currentIp } from './request-context';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Append-only record of who changed what. Pass the transaction's connection so the audit row
 * commits or rolls back together with the change it describes.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  async record(entry: AuditEntry, q: Queryable = this.db): Promise<void> {
    await q.query(
      `insert into audit_log (actor_id, action, entity_type, entity_id, before_data, after_data, ip_address)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.actorId,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        currentIp(),
      ],
    );
  }

  list(filter: { entityType?: string; entityId?: string; limit: number }) {
    return this.db.rows(
      `select a.id, a.actor_id, e.full_name as actor_name, a.action, a.entity_type, a.entity_id,
              a.before_data, a.after_data, a.ip_address, a.created_at
         from audit_log a left join employees e on e.id = a.actor_id
        where ($1::text is null or a.entity_type = $1)
          and ($2::text is null or a.entity_id = $2)
        order by a.id desc
        limit $3`,
      [filter.entityType ?? null, filter.entityId ?? null, filter.limit],
    );
  }
}
