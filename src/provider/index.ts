// src/provider/index.ts — public provider factory (PLAN #8)
import { CommandCodeLanguageModel, type CommandCodeModelOptions } from "./command-code-model.js"

export function createCommandCode(options: CommandCodeModelOptions = {}) {
  return {
    languageModel(modelId: string) {
      return new CommandCodeLanguageModel(options, modelId)
    },
  }
}

export type { CommandCodeModelOptions } from "./command-code-model.js"
