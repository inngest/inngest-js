import { NeonPostgres } from "@langchain/community/vectorstores/neon";
import { OpenAIEmbeddings } from "@langchain/openai";

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 512,
  model: "text-embedding-3-small",
});

// Each workspace has its own vector store
export const loadVectorStore = async (tableName: string) => {
  return await NeonPostgres.initialize(embeddings, {
    connectionString: process.env.POSTGRES_URL!,
    tableName,
    columns: {
      contentColumnName: "content",
      metadataColumnName: "metadata",
      vectorColumnName: "embedding",
    },
  });
};
