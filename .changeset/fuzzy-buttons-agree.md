---
"@inngest/ai": patch
---

Add Azure OpenAI adapter and model support

- Introduced a new `AzureOpenAiAiAdapter` type definition, following the OpenAI I/O format.
- Registered `"azure-openai"` as a supported AI adapter format.
- Implemented a `azureOpenai` model creator for Azure OpenAI, handling endpoint, deployment, and version configuration.
- Added strongly typed input/output for Azure OpenAI, mirroring OpenAI’s message/completion shape.
- Updated `adapters/index.ts` and `models/index.ts` to export new Azure OpenAI adapter/model.
- Ensured Azure-specific request construction and parameterization in the model creator.
