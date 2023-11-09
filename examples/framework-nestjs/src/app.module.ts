import { Logger, Module } from '@nestjs/common';
import { AppService } from './app.service';

@Module({
  imports: [],
  controllers: [],
  providers: [Logger, AppService],
})
export class AppModule {}
