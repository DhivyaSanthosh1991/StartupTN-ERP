import { Injectable } from '@nestjs/common';
import { Queryable } from '../db/db.service';

type Recalc = (q: Queryable, employeeId: string, from: string, to: string) => Promise<void>;

/**
 * Leave, OD and attendance corrections all change what an attendance day should look like.
 * They call run() inside their own transaction; the attendance module registers the actual
 * recalculation. This keeps those modules from importing each other.
 */
@Injectable()
export class DayRecalc {
  private fn?: Recalc;

  register(fn: Recalc) {
    this.fn = fn;
  }

  async run(q: Queryable, employeeId: string, from: string, to: string): Promise<void> {
    if (this.fn) await this.fn(q, employeeId, from, to);
  }
}
