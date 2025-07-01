/* eslint-disable @typescript-eslint/no-namespace */
import { type AiAdapter } from "../adapter.js";

export interface GeminiAiAdapter extends AiAdapter {
  /**
   * Format of the IO for this model
   */
  format: "gemini";

  "~types": {
    input: GeminiAiAdapter.Input;
    output: GeminiAiAdapter.Output;
  };
}

export namespace GeminiAiAdapter {
  export type Input = GenerateContentRequest;

  export type Output = GenerateContentResponse;

  /**
   * The model that will complete your prompt.
   * See [models](https://ai.google.dev/models/gemini) for additional
   * details and options.
   */
  export type Model =
    // eslint-disable-next-line @typescript-eslint/ban-types
    | (string & {})
    | "gemini-1.5-flash"
    | "gemini-1.5-flash-8b"
    | "gemini-1.5-pro"
    | "gemini-1.0-pro"
    | "gemini-2.0-flash"
    | "gemini-2.0-flash-lite"
    | "gemini-2.5-pro"
    | "gemini-2.5-flash"
    | "gemini-2.5-flash-lite-preview-06-17"
    | "text-embedding-004"
    | "aqa";

  export interface GenerateContentRequest {
    /**
     * Required. The content of the current conversation with the model.
     * For single-turn queries, this is a single instance. For multi-turn queries like chat,
     * this is a repeated field that contains the conversation history and the latest request.
     */
    contents: Array<Content>;

    /**
     * Optional. A list of `Tools` the `Model` may use to generate the next response.
     */
    tools?: Array<Tool>;

    /**
     * Optional. Tool configuration for any `Tool` specified in the request.
     */
    toolConfig?: ToolConfig;

    /**
     * Optional. A list of unique `SafetySetting` instances for blocking unsafe content.
     */
    safetySettings?: Array<SafetySetting>;

    /**
     * Optional. Developer set system instruction(s). Currently, text only.
     */
    systemInstruction?: Content;

    /**
     * Optional. Configuration options for model generation and outputs.
     */
    generationConfig?: GenerationConfig;

    /**
     * Optional. The name of the content cached to use as context to serve the prediction.
     * Format: `cachedContents/{cachedContent}`
     */
    cachedContent?: string;
  }

  export interface Content {
    /**
     * The parts that make up the content of the message.
     * A Part can be either a text or an image.
     */
    parts: Array<Part>;

    /**
     * The role of the entity that is creating this message.
     */
    role?: "user" | "model" | "system";
  }

  export type Part =
    | TextPart
    | ImagePart
    | VideoPart
    | AudioPart
    | DocumentPart
    | FunctionCallPart
    | FunctionResponsePart;

  export interface TextPart {
    /**
     * The text content.
     */
    text: string;
  }

  export interface ImagePart {
    /**
     * Inline image data.
     */
    inlineData: {
      /**
       * Base64 encoded image data.
       */
      data: string;
      /**
       * The MIME type of the image data.
       */
      mimeType: string;
    };
  }

  export interface VideoPart {
    /**
     * Inline video data.
     */
    inlineData: {
      /**
       * Base64 encoded video data.
       */
      data: string;
      /**
       * The MIME type of the video data.
       */
      mimeType: string;
    };
  }

  export interface AudioPart {
    /**
     * Inline audio data.
     */
    inlineData: {
      /**
       * Base64 encoded audio data.
       */
      data: string;
      /**
       * The MIME type of the audio data.
       */
      mimeType: string;
    };
  }

  export interface DocumentPart {
    /**
     * Inline document data.
     */
    inlineData: {
      /**
       * Base64 encoded document data.
       */
      data: string;
      /**
       * The MIME type of the document data.
       */
      mimeType: string;
    };
    /**
     * Document URL.
     */
    fileData?: {
      /**
       * The URL of the document.
       */
      fileUri: string;
      /**
       * The MIME type of the document.
       */
      mimeType: string;
    };
  }

  export interface FunctionCallPart {
    /**
     * The function call.
     */
    functionCall: {
      /**
       * The name of the function to call.
       */
      name: string;
      /**
       * The arguments to pass to the function.
       */
      args: Record<string, unknown>;
    };
  }

  export interface FunctionResponsePart {
    /**
     * The function response.
     */
    functionResponse: {
      /**
       * The name of the function that was called.
       */
      name: string;
      /**
       * The response from the function.
       */
      response: Record<string, unknown>;
    };
  }

  export interface Tool {
    /**
     * The function declaration.
     */
    functionDeclarations: Array<FunctionDeclaration>;
  }

  export interface FunctionDeclaration {
    /**
     * The name of the function.
     */
    name: string;
    /**
     * The description of the function.
     */
    description?: string;
    /**
     * The parameters of the function.
     */
    parameters: {
      /**
       * The type of the parameters.
       */
      type: string;
      /**
       * The properties of the parameters.
       */
      properties?: Record<
        string,
        {
          type: string;
          description?: string;
        }
      >;
      /**
       * The required parameters.
       */
      required?: Array<string>;
    };
  }

  export interface ToolConfig {
    /**
     * Tool configuration settings.
     */
    functionCallingConfig?: {
      /**
       * Mode for function calling.
       */
      mode?: "AUTO" | "ANY" | "NONE";
      /**
       * Allowed functions to call.
       */
      allowedFunctionNames?: Array<string>;
    };
  }

  export interface SafetySetting {
    /**
     * The category for this setting.
     */
    category: HarmCategory;
    /**
     * Controls the probability threshold at which harm is blocked.
     */
    threshold: HarmBlockThreshold;
  }

  export enum HarmCategory {
    HARM_CATEGORY_UNSPECIFIED = "HARM_CATEGORY_UNSPECIFIED",
    HARM_CATEGORY_HATE_SPEECH = "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT = "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT = "HARM_CATEGORY_DANGEROUS_CONTENT",
    HARM_CATEGORY_HARASSMENT = "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_CIVIC_INTEGRITY = "HARM_CATEGORY_CIVIC_INTEGRITY",
  }

  export enum HarmBlockThreshold {
    HARM_BLOCK_THRESHOLD_UNSPECIFIED = "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
    BLOCK_LOW_AND_ABOVE = "BLOCK_LOW_AND_ABOVE",
    BLOCK_MEDIUM_AND_ABOVE = "BLOCK_MEDIUM_AND_ABOVE",
    BLOCK_ONLY_HIGH = "BLOCK_ONLY_HIGH",
    BLOCK_NONE = "BLOCK_NONE",
    OFF = "OFF",
  }

  export interface GenerationConfig {
    /**
     * Temperature controls the randomness of the output.
     */
    temperature?: number;
    /**
     * Top-p changes how the model selects tokens for output.
     */
    topP?: number;
    /**
     * Top-k changes how the model selects tokens for output.
     */
    topK?: number;
    /**
     * The maximum number of tokens to generate.
     */
    maxOutputTokens?: number;
    /**
     * A list of strings that will stop generation if they are generated.
     */
    stopSequences?: Array<string>;
    /**
     * Controls the likelihood of the model generating the same sequence of tokens.
     */
    presencePenalty?: number;
    /**
     * Controls the likelihood of the model generating the same token.
     */
    frequencyPenalty?: number;
    /**
     * Controls the resolution of media in the response.
     */
    mediaResolution?:
      | "MEDIA_RESOLUTION_UNSPECIFIED"
      | "MEDIA_RESOLUTION_LOW"
      | "MEDIA_RESOLUTION_MEDIUM"
      | "MEDIA_RESOLUTION_HIGH";
  }

  export interface GenerateContentResponse {
    /**
     * The generated response from the model.
     */
    candidates?: Array<Candidate>;
    /**
     * Usage metadata about the response.
     */
    usageMetadata?: UsageMetadata;
    /**
     * Prompt feedback related to the input prompt.
     */
    promptFeedback?: PromptFeedback;

    /**
     * Error information.
     */
    error?: {
      code: number;
      message: string;
      status: string;
    };
  }

  export interface Candidate {
    /**
     * The generated content.
     */
    content: Content;
    /**
     * The reason why the model stopped generating tokens.
     */
    finishReason?:
      | "FINISH_REASON_UNSPECIFIED"
      | "STOP"
      | "MAX_TOKENS"
      | "SAFETY"
      | "RECITATION"
      | "OTHER";
    /**
     * Safety ratings for the content.
     */
    safetyRatings?: Array<SafetyRating>;
    /**
     * Citation information for model-generated content.
     */
    citationMetadata?: CitationMetadata;
  }

  export interface SafetyRating {
    /**
     * The category for this rating.
     */
    category: HarmCategory;
    /**
     * The probability of harm for this content.
     */
    probability:
      | "HARM_PROBABILITY_UNSPECIFIED"
      | "NEGLIGIBLE"
      | "LOW"
      | "MEDIUM"
      | "HIGH";
    /**
     * Whether this content was blocked because of this rating.
     */
    blocked?: boolean;
  }

  export interface CitationMetadata {
    /**
     * Citations for sources attributed in the content.
     */
    citations?: Array<Citation>;
  }

  export interface Citation {
    /**
     * The citation source.
     */
    startIndex?: number;
    /**
     * The end index of the citation in the content.
     */
    endIndex?: number;
    /**
     * The URI of the source.
     */
    uri?: string;
    /**
     * The title of the source.
     */
    title?: string;
    /**
     * The license of the source.
     */
    license?: string;
    /**
     * The publication date of the source.
     */
    publicationDate?: string;
  }

  export interface UsageMetadata {
    /**
     * The number of tokens in the prompt.
     */
    promptTokenCount?: number;
    /**
     * The number of tokens in the response.
     */
    candidatesTokenCount?: number;
    /**
     * The total number of tokens processed.
     */
    totalTokenCount?: number;
  }

  export interface PromptFeedback {
    /**
     * The safety ratings for the prompt.
     */
    safetyRatings?: Array<SafetyRating>;
    /**
     * Whether the prompt was blocked.
     */
    blockReason?: "BLOCK_REASON_UNSPECIFIED" | "SAFETY" | "OTHER";
  }
}
