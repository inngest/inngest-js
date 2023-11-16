import { serve } from "inngest/koa";
import Koa from "koa";
import bodyParser from "koa-bodyparser";
import { functions, inngest } from "./inngest";

const app = new Koa();
app.use(bodyParser());

const handler = serve({
  client: inngest,
  functions,
});

app.use((ctx) => {
  if (ctx.request.path === "/api/inngest") {
    return handler(ctx);
  }
});

app.listen(3000);
