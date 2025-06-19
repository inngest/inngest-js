import { type AiAdapter } from "../adapter.js"
import { type AzureOpenAiAiAdapter } from "../adapters/azure-openai.js"
import { openai, type OpenAi } from "./openai.js"

/**
 * Creates an Azure OpenAI model that uses the OpenAI chat format.
 *
 * This model extends the base OpenAI model with Azure-specific configurations:
 * - Uses a custom endpoint URL format: `{endpoint}/openai/deployments/{deployment}/chat/completions`
 * - Requires an API version parameter in the URL
 * - Uses Azure's API key authentication instead of OpenAI's Bearer token
 *
 * The model inherits all input/output types from the OpenAI adapter but uses
 * Azure's endpoint structure and authentication method.
 */
export const azureOpenai: AiAdapter.ModelCreator<
  [options: AzureOpenAi.AiModelOptions],
  AzureOpenAi.AiModel
> = (options) => {
  if (!options.endpoint) {
    throw new Error("Azure OpenAI endpoint is required")
  }

  // Create base OpenAI model with Azure endpoint
  const baseModel = openai({
    model: options.model,
    apiKey: options.apiKey,
    baseUrl: options.endpoint,
    defaultParameters: options.defaultParameters,
  })

  // Construct Azure-specific URL with deployment and API version
  const url = new URL(
    `openai/deployments/${options.deployment}/chat/completions`,
    options.endpoint
  )
  url.searchParams.set("api-version", options.apiVersion)

  return {
    ...baseModel,
    url: url.href,
    format: "azure-openai" as const,
    onCall(_, body) {
      Object.assign(body, options.defaultParameters);
      body.model ||= options.model;
    },
    // Override headers to use Azure's API key format
    headers: {
      "api-key": baseModel.authKey,
      "Content-Type": "application/json",
    },
    options,
  }
}

export namespace AzureOpenAi {
  /** Reuse OpenAI's model type */
  export type Model = OpenAi.Model

  /**
   * Options for creating an Azure OpenAI model.
   * Extends OpenAI options but replaces baseUrl with Azure-specific fields:
   * - endpoint: The Azure OpenAI endpoint URL
   * - deployment: The deployment name for the model
   * - apiVersion: The Azure OpenAI API version to use
   */
  export interface AiModelOptions extends Omit<OpenAi.AiModelOptions, "baseUrl"> {
    endpoint: string
    deployment: string
    apiVersion: string
  }

  /**
   * An Azure OpenAI model that extends the OpenAI adapter.
   * Uses the same input/output types as OpenAI but with Azure-specific
   * endpoint structure and authentication.
   */
  export interface AiModel extends AzureOpenAiAiAdapter {
    options: AiModelOptions
  }
}
