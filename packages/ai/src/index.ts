// AI provider layer and prompts

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelProvider {
  name: 'deepinfra' | 'anthropic' | 'ollama';
  complete(req: {
    system: string;
    messages: Message[];
    jsonSchema?: object;
    maxOutputTokens: number;
    cacheKey?: string;
  }): Promise<{ text: string; json?: unknown; usage: TokenUsage }>;
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

// Placeholder implementations
export class DeepInfraProvider implements ModelProvider {
  name = 'deepinfra' as const;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // TODO: Implement DeepInfra API call
    throw new Error('DeepInfra provider not yet implemented');
  }
}

export class AnthropicProvider implements ModelProvider {
  name = 'anthropic' as const;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // TODO: Implement Anthropic API call
    throw new Error('Anthropic provider not yet implemented');
  }
}

export class OllamaProvider implements ModelProvider {
  name = 'ollama' as const;

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // TODO: Implement Ollama API call
    throw new Error('Ollama provider not yet implemented');
  }
}

export function getProvider(name: string): ModelProvider {
  switch (name) {
    case 'deepinfra':
      return new DeepInfraProvider();
    case 'anthropic':
      return new AnthropicProvider();
    case 'ollama':
      return new OllamaProvider();
    default:
      throw new Error(`Unknown provider: ${name}`);
  }
}
