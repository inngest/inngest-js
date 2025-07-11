"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export default function ImportPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setStatus("Please select a CSV file.");
      return;
    }
    try {
      const text = await file.text();
      // Simple CSV parsing (assumes header row)
      const [headerLine, ...lines] = text.split(/\r?\n/).filter(Boolean);
      const headers = headerLine.split(",").map((h) => h.trim());
      const contacts = lines.map((line) => {
        const values = line.split(",");
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => (obj[h] = values[i]?.trim() || ""));
        return obj;
      });
      // Send to API
      const res = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contacts }),
      });
      if (res.ok) {
        setStatus(
          "Contacts import started! You will receive an email when the import is complete."
        );
      } else {
        setStatus("Import failed: " + (await res.text()));
      }
    } catch (err) {
      setStatus("Error: " + String(err));
    }
  }

  return (
    <div className="flex flex-col gap-8 py-12 max-w-xl">
      <h1 className="text-2xl font-bold mb-4">Import Contacts</h1>
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <div>
          <label className="block font-semibold mb-1">Upload CSV File</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            className="w-full border rounded px-3 py-2"
          />
        </div>
        <Button type="submit">Import Contacts</Button>
      </form>
      {status && <div className="mt-4 text-sm">{status}</div>}
    </div>
  );
}
