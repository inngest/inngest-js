import { readFile } from "node:fs/promises";
import { prepareConnectionConfig } from "../../components/connect/config.ts";
import { Inngest } from "../../components/Inngest.ts";

async function main() {
  const client = new Inngest({ id: "test", isDev: true });

  // Model concurrent discovery: registration follows I/O completion, but every
  // process defines exactly the same functions. No random input or config.
  await Promise.all(
    Array.from({ length: 16 }, async (_, i) => {
      await readFile("package.json");
      client.createFunction(
        { id: `function-${i}`, triggers: [{ event: "demo/event" }] },
        () => "ok",
      );
    }),
  );

  // Omitting functions exercises the client's automatic function collection.
  const { connectionData } = prepareConnectionConfig([{ client }], client);
  process.stdout.write(
    new TextDecoder().decode(connectionData.apps[0]?.functions),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
