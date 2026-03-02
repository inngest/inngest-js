"use client";
import { useState } from "react";
import useSWR from "swr";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function NewCampaignPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: segments, isLoading } = useSWR("/api/segments?all=1", fetcher);
  const [form, setForm] = useState({
    name: "",
    subject: "",
    content: "",
    segmentId: searchParams.get("segmentId") || "",
  });
  const [status, setStatus] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          subject: form.subject,
          content: form.content,
          segmentId: Number(form.segmentId),
          status: "draft",
        }),
      });
      if (res.ok) {
        const campaign = await res.json();
        setStatus("Campaign created!");
        router.push(`/campaign/${campaign.id}`);
      } else {
        setStatus("Failed to create campaign");
      }
    } catch (err) {
      setStatus("Error: " + String(err));
    }
  }

  return (
    <div className="max-w-xl mx-auto py-12 flex flex-col gap-8">
      <h1 className="text-2xl font-bold mb-4">Create New Campaign</h1>
      <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
        <div>
          <label className="block font-semibold mb-1">Name</label>
          <input
            className="w-full border rounded px-3 py-2"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Subject</label>
          <input
            className="w-full border rounded px-3 py-2"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Content</label>
          <textarea
            className="w-full border rounded px-3 py-2 min-h-[120px]"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Segment</label>
          <select
            className="w-full border rounded px-3 py-2"
            value={form.segmentId}
            onChange={(e) => setForm({ ...form, segmentId: e.target.value })}
            required
            disabled={isLoading}
          >
            <option value="" disabled>
              {isLoading ? "Loading..." : "Select a segment"}
            </option>
            {segments &&
              segments.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </div>
        <Button type="submit">Create Campaign</Button>
      </form>
      {status && <div className="mt-4 text-sm">{status}</div>}
    </div>
  );
}
