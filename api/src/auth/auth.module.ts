import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleVerifier } from './google-verifier';

@Module({
  controllers: [AuthController],
  providers: [AuthService, GoogleVerifier],
  exports: [AuthService, GoogleVerifier],
})
export class AuthModule {}
