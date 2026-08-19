// src/provider/modalities.ts — image input modalities from generated catalog
// facts. Text-only models are intentionally omitted and use the fallback below.

import { MODEL_INPUT_MODALITIES } from "../catalog/facts.js"

export type CommandCodeInputType = "text" | "image"

export { MODEL_INPUT_MODALITIES }

const TEXT_INPUT_ONLY = ["text"] as const

export function inputModalitiesForModel(modelId: string): readonly CommandCodeInputType[] {
  return MODEL_INPUT_MODALITIES[modelId] ?? TEXT_INPUT_ONLY
}

export function modelSupportsImageInput(modelId: string): boolean {
  return inputModalitiesForModel(modelId).includes("image")
}
