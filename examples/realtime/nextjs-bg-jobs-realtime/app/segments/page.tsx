import SegmentsList from "@/components/segments-list";

export default function SegmentsPage() {
  return (
    <div className="max-w-2xl mx-auto py-12 flex flex-col gap-8">
      <h1 className="text-2xl font-bold mb-4">All Segments</h1>
      <SegmentsList />
    </div>
  );
}
