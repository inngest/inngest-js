---
"inngest": minor
---

Expand AI step metadata extraction to more OTel GenAI span attributes. The SDK now records additional model, provider, response id, token, and request parameter fields from OTel GenAI spans while continuing to ignore prompt and response content.

This removes the previous metadata extraction for Open Inference, Vercel AI SDK-specific, and Langfuse-specific span attributes.
