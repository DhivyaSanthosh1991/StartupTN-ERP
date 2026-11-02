import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth.types';
import { Db } from './db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: Db) {}

  /** For the load balancer: 200 only when the database answers. */
  @Public()
  @Get()
  async health() {
    await this.db.query('select 1');
    return { status: 'ok' };
  }
}
