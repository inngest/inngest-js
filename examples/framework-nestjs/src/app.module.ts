import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { serve } from 'inngest/express';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { functions, inngest } from './inngest';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    const handler = serve(inngest, functions);

    /**
     * NestJS middleware in `main.ts` does not have access to either a parsed or
     * raw body, whereas middleware here does.
     *
     * This means it's critical to add the Inngest handler _here_ so that we can
     * appropriately parse the body of incoming requests from Inngest or the
     * Inngest dev server.
     */
    consumer.apply(handler).forRoutes('/api/inngest');
  }
}
