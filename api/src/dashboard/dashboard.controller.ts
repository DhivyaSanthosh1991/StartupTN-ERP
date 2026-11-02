import { Controller, Get } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/auth.types';
import { DashboardService } from './dashboard.service';

@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  home(@CurrentUser() user: AuthUser) {
    return this.dashboard.forUser(user);
  }
}
