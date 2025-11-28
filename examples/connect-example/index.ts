// a

// aa
import { createServer } from "node:http";
import { connect } from "inngest/connect";
import whyIsNodeRunning from "why-is-node-running";
import { functions, inngest } from "./inngest";

console.log("Starting up worker with pid", process.pid);
console.log("Connecting...");

// Create a local server to receive data from
const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      data: "Hello World!",
    }),
  );
});

server.listen(3000);

connect({
  apps: [
    {
      client: inngest,
      functions,
    },
  ],
  instanceId: "my-worker",
  rewriteGatewayEndpoint: (endpoint) => {
    return endpoint.replace("connect-gateway:8080", "localhost:8100");
  },
  signingKey: "<Signing Key here>",
}).then(async (conn) => {
  console.log("Connected!");

  const statusLog = setInterval(() => {
    console.log(conn.state);
  }, 1000);

  await conn.closed;

  console.log("Closed, clearing");
  clearInterval(statusLog);

  setInterval(() => {
    whyIsNodeRunning();
  }, 2000);
});
