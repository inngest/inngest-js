// For Vite
interface ImportMeta {
  env: {
    INNGEST_DEV?: string;
    VITE_INNGEST_DEV?: string;
    MODE: "development" | "production";
    VITE_MODE: "development" | "production";
    INNGEST_BASE_URL?: string;
    VITE_INNGEST_BASE_URL?: string;
    INNGEST_API_BASE_URL?: string;
    VITE_INNGEST_API_BASE_URL?: string;
    INNGEST_SIGNING_KEY?: string;
    INNGEST_SIGNING_KEY_FALLBACK?: string;
  };
}
