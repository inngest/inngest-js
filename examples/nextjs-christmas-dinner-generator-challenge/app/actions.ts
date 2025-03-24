"use server";
import { inngest } from "@/inngest/client";

export async function generateMeal(formData: FormData) {
  const participantsCount = Number(formData.get("participantsCount"));
  const preferences =
    formData.get("preferences")?.toString().split("\n").filter(Boolean) || [];

  const { ids } = await inngest.send({
    name: "meal.generate",
    data: { participantsCount, preferences },
  });

  return ids[0];
}
