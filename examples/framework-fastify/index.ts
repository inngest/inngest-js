import Fastify from "fastify";
import inngestFastify from "inngest/fastify";
import { functions, inngest } from "./inngest";

const fastify = Fastify({
  logger: true,
});

fastify.register(inngestFastify, {
  client: inngest,
  functions,
  options: {},
});

fastify.listen({ port: 3000 }, function (err, address) {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
});
