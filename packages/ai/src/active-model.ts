/**
 * The model the AI jobs run on. The worker and the "how we process your data" page both read
 * this, so the page names the model that is actually in use.
 */
export function activeModel(): string {
  return process.env.AI_MODEL || process.env.DEEPINFRA_MODEL || 'Qwen/Qwen2.5-72B-Instruct';
}
