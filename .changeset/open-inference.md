---
"inngest": minor
---

Expand AI step metadata extraction to allowlisted OpenInference span attributes. The SDK now records additional model, provider, token, cost, prompt, session, user, embedding, and reranker fields from OpenInference spans while continuing to ignore prompt and response content.

This replaces the previous metadata extraction for OTel semantic conventions (`gen_ai.*`), Vercel AI SDK, and Langfuse-specific span attributes.
