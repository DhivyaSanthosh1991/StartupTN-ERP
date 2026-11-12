import { Inject, Injectable } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AuditService } from '../common/audit.service';
import { forbidden, notFound, unauthorized } from '../common/errors';
import { AppConfig, CONFIG } from '../config/config';
import { Db } from '../db/db.service';
import { GoogleVerifier } from './google-verifier';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly google: GoogleVerifier,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async loginWithGoogle(idToken: string) {
    const id = await this.google.verify(idToken);
    if (!id.emailVerified) throw unauthorized('EMAIL_NOT_VERIFIED', 'Your Google email is not verified');

    // Both checks: the address must be on the StartupTN domain AND Google must say the account
    // is managed by that Workspace (a personal Gmail can never carry the "hd" claim).
    const domain = this.config.allowedEmailDomain;
    if (!id.email.endsWith(`@${domain}`) || id.hostedDomain !== domain) {
      throw forbidden('DOMAIN_NOT_ALLOWED', `Sign in with your @${domain} account`);
    }
    return this.sessionFor(id.email, 'google');
  }

  async devLogin(email: string) {
    if (!this.config.devLogin) throw notFound('NOT_FOUND', 'Not found');
    return this.sessionFor(email.toLowerCase(), 'dev');
  }

  private async sessionFor(email: string, via: 'google' | 'dev') {
    const emp = await this.db.one(
      `select id, full_name, status from employees where lower(official_email) = $1`,
      [email],
    );
    if (!emp) {
      throw forbidden('NOT_REGISTERED', 'Your account is not in the employee master yet. Please contact HR');
    }
    if (emp.status !== 'active') {
      throw forbidden('ACCOUNT_INACTIVE', 'This account is no longer active');
    }
    await this.audit.record({ actorId: emp.id, action: 'auth.login', entityType: 'employee', entityId: emp.id, after: { via } });
    return { token: this.issueToken(emp.id), mobileToken: this.issueToken(emp.id, true), employeeId: emp.id as string, fullName: emp.full_name as string };
  }

  issueToken(employeeId: string, mobile = false): string {
    return jwt.sign({}, this.config.jwtSecret, {
      algorithm: 'HS256',
      subject: employeeId,
      // a phone stays signed in far longer than a browser tab
      expiresIn: mobile ? `${this.config.mobileSessionDays}d` : `${this.config.sessionHours}h`,
    });
  }
}
