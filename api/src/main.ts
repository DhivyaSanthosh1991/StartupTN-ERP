import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { loadConfig } from './config/config';
import { loadEnvFile } from './config/env-file';

async function bootstrap() {
  loadEnvFile();
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.register(config));
  configureApp(app, config.trustProxyHops);
  app.enableShutdownHooks();
  await app.listen(config.port);
  console.log(`ERP API listening on :${config.port} (${config.nodeEnv})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
