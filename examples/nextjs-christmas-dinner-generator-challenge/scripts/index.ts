/* eslint-disable @typescript-eslint/no-explicit-any */
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { Document } from "@langchain/core/documents";
import { NeonPostgres } from "@langchain/community/vectorstores/neon";
import { OpenAIEmbeddings } from "@langchain/openai";

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 512,
  model: "text-embedding-3-small",
});

const fileToDatabaseMapping: Record<string, string> = {
  "Thefoodprocessor-holiday.json": "holiday_recipes",
  "Thefoodprocessor-wine_type.json": "wine_pairings",
};

// Constants for batching
const VECTOR_STORE_BATCH_SIZE = 100;

async function processJsonFile(filePath: string) {
  const jsonData = JSON.parse(await fs.readFile(filePath, "utf-8"));
  const tableName = fileToDatabaseMapping[path.basename(filePath)];

  // Prepare all records and their texts for embedding
  const records = jsonData.map((record: any) => ({
    ...record,
    text: `${record.recipe} ${record.holiday}`,
  }));

  // Prepare database records with embeddings
  const documents = records.map(
    (record: any) =>
      new Document({ pageContent: Object.values(record).join(" - ") })
  );

  const vectorStore = await NeonPostgres.initialize(embeddings, {
    connectionString: process.env.POSTGRES_URL!,
    tableName,
    columns: {
      contentColumnName: "content",
      metadataColumnName: "metadata",
      vectorColumnName: "embedding",
    },
  });

  // Process documents in batches
  for (let i = 0; i < documents.length; i += VECTOR_STORE_BATCH_SIZE) {
    const batch = documents.slice(i, i + VECTOR_STORE_BATCH_SIZE);
    console.log(
      `Processing batch ${i / VECTOR_STORE_BATCH_SIZE + 1}/${Math.ceil(
        documents.length / VECTOR_STORE_BATCH_SIZE
      )}`
    );
    await vectorStore.addDocuments(batch);
  }

  return records.length;
}

async function main() {
  const dataDir = path.join(__dirname, "../data");
  const files = await fs.readdir(dataDir);
  const jsonFiles = files.filter((file) => file.endsWith(".json"));

  let totalProcessed = 0;

  for (const file of jsonFiles) {
    const filePath = path.join(dataDir, file);
    console.log(`Processing file: ${file}`);
    const processedCount = await processJsonFile(filePath);
    totalProcessed += processedCount;
    console.log(`Completed processing ${file}: ${processedCount} records`);
  }

  console.log(`Total records processed across all files: ${totalProcessed}`);
}

main().catch(console.error);
