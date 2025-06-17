import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { fastifyPlugin as inngestFastify } from 'inngest/fastify';

import { inngest } from '@modules/common/inngest/client';
import { getInngestFunctions } from '@modules/common/inngest/functions';

import { AppModule } from './app.module';
import { AppService } from './app.service';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // Inject Dependencies into inngest functions
  const logger = app.get(Logger);
  const appService = app.get(AppService);

  // Pass dependencies into this function
  const inngestFunctions = getInngestFunctions({
    appService,
    logger,
  });

  // Register inngest endpoint
  app.register(inngestFastify, {
    client: inngest,
    functions: inngestFunctions,
  });
  // Start listening for http requests
  await app.listen(3000);
}

bootstrap();
