import { DynamicModule, Global, Module } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/config';
import { Db } from '../db/db.service';
import { AuditService } from './audit.service';
import { DayRecalc } from './day-recalc.service';
import { NotificationService } from './notification.service';
import { SettingsService } from './settings.service';

@Global()
@Module({})
export class CommonModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: CommonModule,
      providers: [{ provide: CONFIG, useValue: config }, Db, AuditService, SettingsService, NotificationService, DayRecalc],
      exports: [CONFIG, Db, AuditService, SettingsService, NotificationService, DayRecalc],
    };
  }
}
