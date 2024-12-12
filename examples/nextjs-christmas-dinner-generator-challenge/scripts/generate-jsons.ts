import parquet from "@dsnp/parquetjs";
import fs from "fs";
import { glob } from "glob";
import path from "path";

async function parquetToJsonFile(
  filePath: string,
  outputPath: string,
  maxRecords: number = 1000
) {
  let reader = await parquet.ParquetReader.openFile(filePath);
  let cursor = reader.getCursor();
  let records: any = [];
  let record;
  let count = 0;

  while ((record = await cursor.next())) {
    if (maxRecords && count >= maxRecords) break;

    const { id: _, ...cleanRecord } = record as any;
    records.push(cleanRecord);
    count++;
  }
  fs.writeFileSync(outputPath, JSON.stringify(records, null, 2));
}

async function main() {
  // Get max records from command line argument, default to undefined (all records)
  const maxRecords = process.argv[2] ? parseInt(process.argv[2]) : undefined;

  // Find all parquet files in the data directory
  const parquetFiles = await glob("data/*.parquet");

  // Process each parquet file
  await Promise.all(
    parquetFiles.map((parquetFile) => {
      const jsonFile = parquetFile.replace(".parquet", ".json");
      return parquetToJsonFile(parquetFile, jsonFile, maxRecords);
    })
  );
}

main();
