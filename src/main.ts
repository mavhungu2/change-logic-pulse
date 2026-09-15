import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { scrubOwnerCredentials } from './config.js';

// Immediately after dotenv and before anything can read them: the API has no
// use for the migration role's credentials, and what is not in the process
// cannot be used by it.
scrubOwnerCredentials();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The React app is served from a different origin in development.
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' });

  await app.listen(process.env.PORT ?? 3000);
}

await bootstrap();
