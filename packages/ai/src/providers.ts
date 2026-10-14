export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface ModelRequest {
  system: string;
  messages: Message[];
  jsonSchema?: object;
  maxOutputTokens: number;
  cacheKey?: string;
}

export interface ModelResponse {
  text: string;
  json?: unknown;
  usage: TokenUsage;
}

export interface ModelProvider {
  name: 'deepinfra' | 'anthropic' | 'ollama';
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'TimeoutError' || error.name === 'AbortError';
}

function isRetryable(error: unknown): boolean {
  if (isTimeout(error)) {
    return true;
  }
  return error instanceof ProviderHttpError && error.status === 429;
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const canRetry = isRetryable(error) && attempt < MAX_ATTEMPTS - 1;
      if (!canRetry) {
        throw error;
      }
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

function parseJsonObject(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function completeOnce(
  provider: ModelProvider,
  req: ModelRequest,
  call: (req: ModelRequest) => Promise<ModelResponse>,
): Promise<ModelResponse> {
  const response = await withRetries(() => call(req));
  if (!req.jsonSchema) {
    return response;
  }
  if (response.json !== undefined) {
    return response;
  }
  try {
    return { ...response, json: parseJsonObject(response.text) };
  } catch {
    const repaired = await withRetries(() =>
      call({
        ...req,
        messages: [
          ...req.messages,
          { role: 'assistant', content: response.text },
          {
            role: 'user',
            content: 'The previous reply was not valid JSON. Return only one JSON object that matches the schema.',
          },
        ],
      }),
    );
    try {
      const json = repaired.json !== undefined ? repaired.json : parseJsonObject(repaired.text);
      return { ...repaired, json };
    } catch {
      throw new Error(`${provider.name} returned invalid JSON after one repair attempt`);
    }
  }
}

export class DeepInfraProvider implements ModelProvider {
  name = 'deepinfra' as const;
  private apiKey: string;
  private baseUrl = 'https://api.deepinfra.com/v1/openai';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.DEEPINFRA_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('DEEPINFRA_API_KEY not set');
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    return completeOnce(this, req, (callReq) => this.call(callReq));
  }

  private async call(req: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPINFRA_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        max_tokens: req.maxOutputTokens,
        temperature: 0.3,
        response_format: req.jsonSchema ? { type: 'json_object' } : undefined,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ProviderHttpError(response.status, `DeepInfra API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const choice = data.choices[0];
    const usage = data.usage;
    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = parseJsonObject(choice.message.content);
      } catch {
        json = undefined;
      }
    }

    return {
      text: choice.message.content,
      json,
      usage: {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens,
      },
    };
  }
}

export class AnthropicProvider implements ModelProvider {
  name = 'anthropic' as const;
  private apiKey: string;
  private baseUrl = 'https://api.anthropic.com/v1/messages';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY || '';
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    return completeOnce(this, req, (callReq) => this.call(callReq));
  }

  private async call(req: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        system: req.system,
        messages: req.messages,
        max_tokens: req.maxOutputTokens,
        temperature: 0.3,
        tools: req.jsonSchema
          ? [
              {
                name: 'output_json',
                description: 'Output structured data',
                input_schema: req.jsonSchema,
              },
            ]
          : undefined,
        tool_choice: req.jsonSchema ? { type: 'tool', name: 'output_json' } : undefined,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ProviderHttpError(response.status, `Anthropic API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      content: { type: string; text?: string; input?: unknown }[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    const usage = data.usage;
    let json: unknown;
    let text = data.content.find((block) => block.type === 'text')?.text ?? '';

    if (req.jsonSchema && data.stop_reason === 'tool_use') {
      const toolBlock = data.content.find((block) => block.type === 'tool_use');
      if (toolBlock && toolBlock.input !== undefined) {
        json = typeof toolBlock.input === 'string' ? parseJsonObject(toolBlock.input) : toolBlock.input;
        text = JSON.stringify(json);
      }
    }

    return {
      text,
      json,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
      },
    };
  }
}

export class OllamaProvider implements ModelProvider {
  name = 'ollama' as const;
  private baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

  async complete(req: ModelRequest): Promise<ModelResponse> {
    return completeOnce(this, req, (callReq) => this.call(callReq));
  }

  private async call(req: ModelRequest): Promise<ModelResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'llama3',
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        stream: false,
        options: {
          num_predict: req.maxOutputTokens,
          temperature: 0.3,
        },
        format: req.jsonSchema ? 'json' : undefined,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new ProviderHttpError(response.status, `Ollama API error: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      message: { content: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = parseJsonObject(data.message.content);
      } catch {
        json = undefined;
      }
    }

    return {
      text: data.message.content,
      json,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
    };
  }
}

export type ProviderName = 'deepinfra' | 'anthropic' | 'ollama';

function createProvider(name: ProviderName, apiKey?: string): ModelProvider {
  switch (name) {
    case 'deepinfra':
      return new DeepInfraProvider(apiKey);
    case 'anthropic':
      return new AnthropicProvider(apiKey);
    case 'ollama':
      return new OllamaProvider();
    default: {
      const unexpected: never = name;
      throw new Error(`Unknown provider: ${String(unexpected)}`);
    }
  }
}

export function getProvider(name: string, apiKey?: string): ModelProvider {
  if (name === 'deepinfra' || name === 'anthropic' || name === 'ollama') {
    return createProvider(name, apiKey);
  }
  throw new Error(`Unknown provider: ${name}`);
}
