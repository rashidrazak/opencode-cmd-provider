// src/provider/index.ts
// Stub — real factory implemented in issue #8.
export function createCommandCode(_options: Record<string, unknown> = {}): {
  languageModel(modelId: string): unknown
} {
  return {
    languageModel() {
      throw new Error("createCommandCode is implemented in #8")
    },
  }
}
