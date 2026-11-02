import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { requestContextMiddleware } from './common/request-context';

/** Settings shared by the real server and the test harness. */
export function configureApp(app: INestApplication, trustProxyHops = 1) {
  const http = app.getHttpAdapter().getInstance();
  // How many proxies sit in front of the API (1 = a load balancer; 2 = CloudFront and then a load balancer),
  // so that req.ip, and the address kept in the audit log, is the real client's.
  http.set('trust proxy', trustProxyHops);
  // Check-in sends a small photo as base64 inside the JSON body, which is more than the 100 KB default.
  (app as NestExpressApplication).useBodyParser('json', { limit: '512kb' });
  // HR uploads an export from the biometric machine's software as plain text; a month for a whole office is a few MB.
  (app as NestExpressApplication).useBodyParser('text', { limit: '8mb', type: ['text/plain', 'text/csv'] });
  app.use(helmet());
  app.use(cookieParser());
  app.use(requestContextMiddleware);
  app.setGlobalPrefix('api');
}
