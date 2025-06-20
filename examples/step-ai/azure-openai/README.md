# Azure OpenAI Example

This example demonstrates how to use Azure OpenAI with Inngest's Step AI functionality.

## Setup

1. Create a `.env` file in this directory with your Azure OpenAI credentials:

```env
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_API_KEY=your-api-key-here
```

2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm run dev
```

## Testing

You can test the function by either invoking it from the Inngest dev server or by sending a POST request to trigger the event:

```bash
curl -X POST http://localhost:3000/api/inngest \
  -H "Content-Type: application/json" \
  -d '{
    "name": "azure-test-function/event",
    "data": {}
  }'
```

## Azure OpenAI Requirements

- An Azure OpenAI resource
- A deployed model on Azure AI Foundry
- The appropriate API key, deployment name (model name) and endpoint URL
