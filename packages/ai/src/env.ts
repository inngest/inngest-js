export type EnvValue = string | undefined;
export type Env = Record<string, EnvValue>;

/**
 * The Deno environment, which is not always available.
 */
declare const Deno: {
  env: { toObject: () => Env };
};

/**
 * The Netlify environment, which is not always available.
 */
declare const Netlify: {
  env: { toObject: () => Env };
};

/**
 * allProcessEnv returns the current process environment variables, or an empty
 * object if they cannot be read, making sure we support environments other than
 * Node such as Deno, too.
 *
 * Using this ensures we don't dangerously access `process.env` in environments
 * where it may not be defined, such as Deno or the browser.
 */
export const allProcessEnv = (): Env => {
  // Node, or Node-like environments
  try {
    if (process.env) {
      return process.env;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_err) {
    // noop
  }

  // Deno
  try {
    const env = Deno.env.toObject();

    if (env) {
      return env;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_err) {
    // noop
  }

  // Netlify
  try {
    const env = Netlify.env.toObject();

    if (env) {
      return env;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_err) {
    // noop
  }

  return {};
};

export const processEnv = (key: string): EnvValue => {
  return allProcessEnv()[key];
};

export enum envKeys {
  OpenAiApiKey = "OPENAI_API_KEY",
  GeminiApiKey = "GEMINI_API_KEY",
  AnthropicApiKey = "ANTHROPIC_API_KEY",
  DeepSeekApiKey = "DEEPSEEK_API_KEY",
  GrokApiKey = "XAI_API_KEY",
  AzureOpenAiApiKey = "AZURE_OPENAI_API_KEY",
  TzafonApiKey = "TZAFON_API_KEY",
}
