import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/config';
import { forbidden } from './errors';

/**
 * When REQUIRE_MOBILE_APP is on, check-in, breaks, presence checks and location tracking only work
 * from the phone app (which sends "x-client: mobile"). HR/admin screens on the web are unaffected.
 */
@Injectable()
export class AppOnlyGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (!this.config.requireMobileApp) return true;
    const req = ctx.switchToHttp().getRequest();
    if (req.headers?.['x-client'] === 'mobile') return true;
    throw forbidden('USE_THE_APP', 'Check-in and tracking work only in the StartupTN mobile app. Please open the app on your phone');
  }
}
