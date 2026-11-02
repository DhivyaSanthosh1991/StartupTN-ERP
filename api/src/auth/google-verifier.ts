import { Inject, Injectable } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { AppConfig, CONFIG } from '../config/config';
import { unauthorized } from '../common/errors';

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  /** Google Workspace domain the account belongs to ("hd" claim); absent for personal Gmail. */
  hostedDomain?: string;
  name?: string;
  picture?: string;
}

/** Thin wrapper so tests can replace Google with a fake. */
@Injectable()
export class GoogleVerifier {
  private readonly client = new OAuth2Client();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!this.config.googleClientId) {
      throw unauthorized('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured on this server');
    }
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.config.googleClientId });
      const p = ticket.getPayload();
      if (!p?.email) throw new Error('no email in token');
      return {
        email: p.email.toLowerCase(),
        emailVerified: p.email_verified === true,
        hostedDomain: p.hd?.toLowerCase(),
        name: p.name,
        picture: p.picture,
      };
    } catch {
      throw unauthorized('BAD_GOOGLE_TOKEN', 'Google sign-in could not be verified. Please try again');
    }
  }
}
