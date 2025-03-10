import { getInngestApp } from "@/inngest";
import { useMemo } from "react";

export const useInngestApp = () => {
  return useMemo(getInngestApp, []);
};
