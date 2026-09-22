// src/deals/vendor.ts — model id → vendor family mapping for the config hook.
// The value derives from the model id namespace, never from scraped data, so a
// mapped row cannot drift with the docs; the prefix table itself is written by
// hand, so an upstream namespace added or renamed under us — z-ai/ for the
// GLM-5.3 Flash pair, alongside the zai-org/ spelling — ships with no family
// until its prefix is listed here. Unknown ids map to undefined and the family
// field is left unset.
const VENDOR_FAMILIES: Readonly<Record<string, string>> = {
  "claude-": "claude",
  "gpt-": "gpt",
  "google/": "gemini",
  "deepseek/": "deepseek",
  "Qwen/": "qwen",
  "moonshotai/": "kimi",
  "z-ai/": "glm",
  "zai-org/": "glm",
  "MiniMaxAI/": "minimax",
  "xiaomi/": "mimo",
  "stepfun/": "step",
  "tencent/": "tencent",
  "meituan/": "longcat",
  "inclusionai/": "ling",
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
