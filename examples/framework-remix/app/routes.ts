import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("api/inngest", "routes/api/inngest.ts"),
] satisfies RouteConfig;
