import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { serve } from 'inngest/express';

import { inngest } from '@modules/common/inngest/client';
import { getInngestFunctions } from '@modules/common/inngest/functions';

import { AppModule } from './app.module';
import { AppService } from './app.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: true,
  });

  // Setup inngest
  app.useBodyParser('json', { limit: '10mb' });

  // Inject Dependencies into inngest functions

  const logger = app.get(Logger);
  const appService = app.get(AppService);

  // Pass dependencies into this function
  const inngestFunctions = getInngestFunctions({
    appService,
    logger,
  });

  // Register inngest endpoint
  app.use(
    '/api/inngest',
    serve({
      client: inngest,
      functions: inngestFunctions,
    }),
  );

  // Start listening for http requests
  await app.listen(3000);
}

bootstrap();
