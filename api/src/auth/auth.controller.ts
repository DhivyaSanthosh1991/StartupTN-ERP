import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Public, SESSION_COOKIE } from '../common/auth.types';
import { zodPipe } from '../common/zod.pipe';
import { AppConfig, CONFIG } from '../config/config';
import { AuthService } from './auth.service';

const googleBody = z.object({ idToken: z.string().min(20) });
const devBody = z.object({ email: z.string().email() });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** What the sign-in screen needs to know. */
  @Public()
  @Get('config')
  getConfig() {
    return {
      googleClientId: this.config.googleClientId,
      allowedDomain: this.config.allowedEmailDomain,
      devLogin: this.config.devLogin,
    };
  }

  @Public()
  @Post('google')
  @HttpCode(200)
  async google(@Body(zodPipe(googleBody)) body: z.infer<typeof googleBody>, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.loginWithGoogle(body.idToken);
    this.setCookie(res, s.token);
    return { employeeId: s.employeeId, fullName: s.fullName };
  }

  @Public()
  @Post('dev-login')
  @HttpCode(200)
  async devLogin(@Body(zodPipe(devBody)) body: z.infer<typeof devBody>, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.devLogin(body.email);
    this.setCookie(res, s.token);
    return { employeeId: s.employeeId, fullName: s.fullName };
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  private setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
      maxAge: this.config.sessionHours * 3_600_000,
      path: '/',
    });
  }
}
