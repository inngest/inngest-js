"use client";
import { useEffect, useState } from "react";
import { useInngestSubscription } from "@inngest/realtime/hooks";
import useSWR from "swr";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { fetchSubscriptionToken } from "@/app/actions";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function CampaignViewPage() {
  const [enabled, setUpdatesEnabled] = useState<boolean>(true);
  const { id } = useParams();

  const { latestData: latestUpdate } = useInngestSubscription({
    refreshToken: () => fetchSubscriptionToken(id as string),
    bufferInterval: 500,
    enabled,
  });

  const { data: campaign, isLoading: loadingCampaign } = useSWR(
    id ? `/api/campaigns/${id}` : null,
    fetcher
  );
  const { data: segments, isLoading: loadingSegments } = useSWR(
    "/api/segments?all=1",
    fetcher
  );
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (campaign) {
      setSubject(campaign.subject || "");
      setContent(campaign.content || "");
    }
  }, [campaign]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segmentId: campaign.segmentId }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setSubject(data.subject);
      setContent(data.content);
    } catch (err: any) {
      setError(err.message || "Failed to generate email");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSend() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${id}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, content }),
      });
      if (!res.ok) throw new Error(await res.text());
      setUpdatesEnabled(true);
      // Optionally show a success message or redirect
    } catch (err: any) {
      setError(err.message || "Failed to send campaign");
    } finally {
      setSending(false);
    }
  }

  if (loadingCampaign || loadingSegments) {
    return <div className="py-12">Loading...</div>;
  }
  if (!campaign) {
    return <div className="py-12 text-red-500">Campaign not found.</div>;
  }
  return (
    <div className="flex flex-col gap-8 py-12">
      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-2xl font-bold">Edit Campaign: {campaign.name}</h1>
      </div>
      <form className="flex flex-col gap-6 max-w-xl">
        <div>
          <label className="block font-semibold mb-1">Email Subject</label>
          <input
            className="w-full border rounded px-3 py-2"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Email Content</label>
          <textarea
            className="w-full border rounded px-3 py-2 min-h-[120px]"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>
        <div>
          <label className="block font-semibold mb-1">Segment</label>
          <ul className="space-y-2">
            {segments &&
              segments
                .filter((s: any) => s.id === campaign.segmentId)
                .map((s: any) => (
                  <li
                    key={s.id}
                    className={`border rounded p-3 flex items-center justify-between bg-primary/10 border-primary`}
                  >
                    <span className="font-semibold">{s.name}</span>
                    <span className="text-xs text-neutral-500">
                      {s.contactCount} contact{s.contactCount === 1 ? "" : "s"}
                    </span>
                    <span className="ml-2 text-xs text-primary font-bold">
                      Selected
                    </span>
                  </li>
                ))}
          </ul>
        </div>
        <div className="flex gap-4 mt-4">
          <Button type="button" onClick={handleSend} disabled={sending}>
            Send Campaign
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? "Generating..." : "Generate content with AI"}
          </Button>
        </div>
        {error && <div className="text-red-500 mt-2">{error}</div>}
      </form>
      {/* Updates Section */}
      {latestUpdate ? (
        <>
          <div className="mt-8">
            <h2 className="text-lg font-semibold mb-2">
              Your campaign is being sent!
            </h2>
            {latestUpdate.data.message}
          </div>
        </>
      ) : null}
    </div>
  );
}
