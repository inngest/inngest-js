"use client";

import { useState } from "react";
import { generateMeal } from "../actions";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";

async function fetchGenerationStatus(eventId: string | null) {
  if (!eventId) return null;
  const response = await fetch(`/api/generationStatus?id=${eventId}`);
  if (!response.ok) return null;
  return response.json();
}

export const HomeView = () => {
  const [eventId, setEventId] = useState<string | null>(null);

  const { data: generationResult, isLoading } = useQuery({
    queryKey: ["generationStatus", eventId],
    queryFn: () => fetchGenerationStatus(eventId),
    enabled: !!eventId,
    refetchInterval: 1000,
  });

  const onSubmit = async (formData: FormData) => {
    const id = await generateMeal(formData);
    console.log("id", id);
    setEventId(id);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-red-700 to-green-800 text-white">
      <div className="max-w-4xl mx-auto px-4 py-12">
        <header className="text-center mb-12">
          <h1 className="text-4xl md:text-6xl font-bold mb-4">
            🎄 Christmas Dinner Generator 🎅
          </h1>
          <p className="text-lg md:text-xl opacity-90">
            Let AI plan your perfect holiday feast!
          </p>
        </header>

        {!eventId ? (
          <form
            action={onSubmit}
            className="bg-white/10 backdrop-blur-sm rounded-lg p-6 md:p-8 shadow-xl"
          >
            <div className="space-y-6">
              <div>
                <label
                  htmlFor="participantsCount"
                  className="block text-lg font-medium mb-2"
                >
                  Number of Guests 👥
                </label>
                <input
                  type="number"
                  id="participantsCount"
                  name="participantsCount"
                  min="1"
                  max="50"
                  required
                  className="w-full px-4 py-2 bg-white/20 rounded-md border border-white/30 focus:border-white/60 focus:ring-2 focus:ring-white/60 focus:outline-none transition-colors text-white placeholder-white/60"
                  placeholder="How many people are you hosting?"
                />
              </div>

              <div>
                <label
                  htmlFor="preferences"
                  className="block text-lg font-medium mb-2"
                >
                  Dietary Preferences & Notes 📝
                </label>
                <textarea
                  id="preferences"
                  name="preferences"
                  required
                  rows={4}
                  className="w-full px-4 py-2 bg-white/20 rounded-md border border-white/30 focus:border-white/60 focus:ring-2 focus:ring-white/60 focus:outline-none transition-colors text-white placeholder-white/60"
                  placeholder="Enter any dietary restrictions, preferences, or special requests (one per line):
- Vegetarian options needed
- Nut allergies
- Traditional turkey preferred"
                />
              </div>

              <button
                type="submit"
                className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-3 px-6 rounded-md transition-colors duration-200 ease-in-out transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <span>Generate Christmas Dinner Plan</span>
                <span className="text-xl">🎄</span>
              </button>
            </div>
          </form>
        ) : (
          <div className="bg-white/10 backdrop-blur-sm rounded-lg p-6 md:p-8 shadow-xl">
            {isLoading || !generationResult || !generationResult.menu ? (
              <div className="text-center">
                <div className="animate-spin text-4xl mb-4">🎄</div>
                <p className="text-lg">
                  Preparing your perfect Christmas dinner...
                </p>
              </div>
            ) : (
              <div className="prose prose-invert max-w-none">
                <h2 className="text-2xl font-bold mb-4">
                  Your Christmas Dinner Menu 🎄
                </h2>
                <div className="whitespace-pre-wrap">
                  {generationResult.menu}
                </div>
                <button
                  onClick={() => setEventId(null)}
                  className="mt-6 bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-md transition-colors"
                >
                  Generate Another Menu
                </button>
              </div>
            )}
          </div>
        )}

        <footer className="mt-12 text-center text-sm opacity-75">
          <p>Made with ❤️ and 🎄 spirit | Powered by Next.js and Inngest</p>
        </footer>
      </div>
    </div>
  );
};

export const Home = () => {
  const queryClient = new QueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <HomeView />
    </QueryClientProvider>
  );
};
