import { Logger } from '@nestjs/common';

import { inngest } from '@modules/common/inngest/client';

import { AppService } from 'src/app.service';

/**
 *
 * @param dependencies dependencies to be injected in the function
 * @returns inngest function that will be supplied to serve middleware
 */
export const hello = (dependencies: {
  appService: AppService;
  logger: Logger;
}) => {
  return inngest.createFunction(
    { id: 'hello-world', triggers: [{ event: 'job/hello.world' }] },
    async ({ event, step }) => {
      await step.run('start-single-jobs', async () => {
        dependencies.logger.log(`Initiating Job`);
        dependencies.appService.helloWorld(); // Call helloWorld() method from app service provider
      });
    },
  );
};
