// src/deals/vendor.ts — model id → vendor family mapping for the config hook.
// Derived from the model id namespace, never from scraped data, so it cannot
// go stale. Unknown ids map to undefined and the family field is left unset.
const VENDOR_FAMILIES: Readonly<Record<string, string>> = {
  "claude-": "claude",
  "gpt-": "gpt",
  "google/": "gemini",
  "deepseek/": "deepseek",
  "Qwen/": "qwen",
  "moonshotai/": "kimi",
  "zai-org/": "glm",
  "MiniMaxAI/": "minimax",
  "xiaomi/": "mimo",
  "stepfun/": "step",
  "tencent/": "tencent",
  "nvidia/": "nemotron",
  "thinkingmachines/": "inkling",
  "poolside/": "laguna",
  "meta/": "muse",
  "xai/": "grok",
  "sakana/": "sakana",
}

export function vendorFamilyForModel(modelId: string): string | undefined {
  for (const [prefix, family] of Object.entries(VENDOR_FAMILIES)) {
    if (modelId.startsWith(prefix)) return family
  }
  return undefined
}
