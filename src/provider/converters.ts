// src/provider/converters.ts — AI SDK v3 messages → Command Code payload (PLAN #2 Part B)
//
// Provider API shapes are documented at https://commandcode.ai/docs/provider:
// - POST /provider/v1/chat/completions follows OpenAI Chat Completions schema
// - POST /provider/v1/messages follows Anthropic Messages schema
// - Text + images only; audio/file/document rejected by schema (FAQ)
//
// Port of pi-commandcode-provider/src/converters.ts. Input is the AI SDK v3
// prompt format (LanguageModelV3Message / LanguageModelV3Prompt):
//
// - { role: "system"; content: string }
// - { role: "user"; content: string | Array<{ type: "text"; text } | { type: "file"; data; mediaType }> }
// - { role: "assistant"; content: Array<{ type: "text" } | { type: "reasoning" } | { type: "tool-call" } | { type: "tool-result" }> }
// - { role: "tool"; content: Array<{ type: "tool-result"; toolCallId; toolName; output }> }
//
// Image parts: v3 names them `file` parts with `data`/`mediaType` (image/*).
// We treat `image`-typed parts as well for forward-compat with other SDK
// shapes. `getApiKey` lives in ./auth-key.ts; `parseStreamEventLine` and
// `mapFinishReason` are issue #3.

import { toJsonSchema } from "./json-schema.js"
import {
  isReasoningModel,
  mappedReasoningEffort,
  resolveProviderReasoning,
  thinkingMetadataForModel,
} from "./reasoning.js"

export { toJsonSchema } from "./json-schema.js"

const DEFAULT_PROVIDER_MAX_TOKENS = 64_000

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function recordArray(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord)
}

export function recordOrEmpty(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      // Some providers stream incomplete JSON argument fragments.
    }
  }
  return {}
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export type CCImagePart = { type: "image"; image: string; mimeType: string }
export type CCContentPart = { type: "text"; text: string } | CCImagePart

type PromptLike = readonly {
  role?: unknown
  content?: unknown
}[]

function imageParts(value: unknown): readonly Record<string, unknown>[] {
  if (isRecord(value)) return isImageFilePart(value) ? [value] : []
  return recordArray(value).filter((part) => isImageFilePart(part))
}

function imageContentError(role: string): Error {
  return new Error(`Selected Command Code model does not support image content in ${role}`)
}

function nonImageFileError(part: Record<string, unknown>, role: string): Error {
  const mime = stringValue(part.mediaType) ?? stringValue(part.mimeType) ?? "unknown type"
  return new Error(
    `Selected Command Code model only accepts text and images, but ${role} contain a non-image file (${mime}). Remove the attachment or convert it to an image.`,
  )
}

function hasImageMediaType(part: Record<string, unknown>): boolean {
  const mime = stringValue(part.mediaType) ?? stringValue(part.mimeType)
  // A `file` part must declare an image/* media type to be forwarded as an
  // image; a `file` with no verifiable image type (and any non-image type) is
  // rejected, since the Provider API accepts text + images only.
  return mime !== undefined && mime.toLowerCase().startsWith("image/")
}

/** True for an `image` part or a `file` part carrying an image/* media type
 * (mediaType or mimeType). Shared by the rejection guard and the content
 * encoders so the image classification is consistent everywhere. */
function isImageFilePart(part: Record<string, unknown>): boolean {
  return part.type === "image" || (part.type === "file" && hasImageMediaType(part))
}

function assertProviderContentParts(parts: readonly Record<string, unknown>[], role: string): void {
  for (const part of parts) {
    if (part.type === "file" && !hasImageMediaType(part)) throw nonImageFileError(part, role)
  }
}

export function assertTextOnlyMessages(messages?: PromptLike): void {
  for (const message of messages ?? []) {
    if (imageParts(message.content).length > 0) {
      const role = message.role === "tool" ? "tool results" : `${String(message.role)} messages`
      throw imageContentError(role)
    }
  }
}

function imageToCommandCode(part: {
  image?: unknown
  data?: unknown
  mimeType?: unknown
  mediaType?: unknown
}): CCImagePart {
  const raw = stringValue(part.image) ?? stringValue(part.data)
  const mimeType = stringValue(part.mimeType) ?? stringValue(part.mediaType)
  if (!raw || raw.length === 0) {
    throw new Error("Invalid image content: expected a base64 data URL string")
  }
  if (raw.startsWith("data:")) {
    const [mime] = raw.slice(5).split(";base64,")
    return { type: "image", image: raw, mimeType: mime ?? mimeType ?? "application/octet-stream" }
  }
  return {
    type: "image",
    image: `data:${mimeType ?? "application/octet-stream"};base64,${raw}`,
    mimeType: mimeType ?? "application/octet-stream",
  }
}

function userContentToCommandCode(content: unknown, allowImages: boolean): unknown {
  if (typeof content === "string") return content

  return recordArray(content).flatMap<CCContentPart>((part) => {
    if (part.type === "text") return [{ type: "text", text: stringValue(part.text) ?? "" }]
    if (part.type === "image" || part.type === "file") {
      if (!allowImages) throw imageContentError("user messages")
      return [imageToCommandCode(part)]
    }
    return []
  })
}

export function textContent(message: { content?: unknown }): string {
  return recordArray(message.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n")
}

export function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`
}

export interface SdkTool {
  description?: string
  parameters: unknown
}

export function toolsToJson(tools?: Record<string, SdkTool> | readonly SdkTool[]): unknown[] {
  if (!tools) return []
  if (Array.isArray(tools)) {
    return tools.map((tool) => ({
      type: "function",
      name: (tool as { name?: unknown }).name ?? "",
      description: tool.description,
      input_schema: tool.parameters ? toJsonSchema(tool.parameters) : {},
    }))
  }
  return Object.entries(tools).map(([name, tool]) => ({
    type: "function",
    name,
    description: tool.description,
    input_schema: tool.parameters ? toJsonSchema(tool.parameters) : {},
  }))
}

function completeToolCallIds(messages?: PromptLike): Set<string> {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()

  for (const message of messages ?? []) {
    if (message.role === "assistant") {
      for (const content of recordArray(message.content)) {
        if (content.type === "tool-call") {
          const id = stringValue(content.toolCallId)
          if (id) callIds.add(id)
        }
      }
    } else if (message.role === "tool") {
      for (const content of recordArray(message.content)) {
        const id = stringValue(content.toolCallId)
        if (id) resultIds.add(id)
      }
    }
  }

  return new Set([...callIds].filter((id) => resultIds.has(id)))
}

function unwrapToolResult(result: unknown): string {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return result.map(unwrapToolResult).filter(Boolean).join("\n")
  if (!isRecord(result)) return String(result ?? "")
  switch (result.type) {
    case "text":
    case "error-text":
      return stringValue(result.value) ?? ""
    case "json":
    case "error-json":
      return JSON.stringify(result.value)
    case "execution-denied":
      return stringValue(result.reason) ?? "Tool execution denied."
    case "content": {
      const text = Array.isArray(result.value)
        ? result.value
            .map((entry) =>
              isRecord(entry) && entry.type === "text" ? (stringValue(entry.text) ?? "") : "",
            )
            .filter(Boolean)
            .join("\n")
        : ""
      return text
    }
    default: {
      const text = stringValue(result.text)
      if (text !== undefined) return text
      const content = result.content
      if (content !== undefined) return unwrapToolResult(content)
      return JSON.stringify(result)
    }
  }
}

export function messagesToCC(
  messages: PromptLike,
  options: { allowImages?: boolean } = {},
): unknown[] {
  const allowImages = options.allowImages ?? false
  if (!allowImages) assertTextOnlyMessages(messages)

  const out: unknown[] = []
  const pairedToolCallIds = completeToolCallIds(messages)

  for (const message of messages ?? []) {
    if (message.role === "user") {
      out.push({
        role: "user",
        content: userContentToCommandCode(message.content, allowImages),
      })
    } else if (message.role === "assistant") {
      const parts: unknown[] = []
      for (const content of recordArray(message.content)) {
        if (content.type === "text") {
          parts.push({ type: "text", text: stringValue(content.text) ?? "" })
        } else if (content.type === "tool-call") {
          const toolCallId = stringValue(content.toolCallId) ?? ""
          if (!pairedToolCallIds.has(toolCallId)) continue
          parts.push({
            type: "tool-call",
            toolCallId,
            toolName: stringValue(content.toolName) ?? "",
            input: recordOrEmpty(content.input ?? content.args ?? content.arguments),
          })
        }
      }
      if (parts.length > 0) out.push({ role: "assistant", content: parts })
    } else if (message.role === "tool") {
      for (const content of recordArray(message.content)) {
        const toolCallId = stringValue(content.toolCallId) ?? ""
        if (!pairedToolCallIds.has(toolCallId)) continue
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId,
              toolName: stringValue(content.toolName) ?? "",
              output: content.isError
                ? { type: "error-text", value: unwrapToolResult(content.result ?? content.output) }
                : { type: "text", value: unwrapToolResult(content.result ?? content.output) },
            },
          ],
        })

        const images = imageParts(content)
        if (images.length > 0) {
          if (!allowImages) throw imageContentError("tool results")
          out.push({
            role: "user",
            content: images.map(imageToCommandCode),
          })
        }
      }
    }
  }
  return out
}

function promptPartToText(value: unknown, depth = 0): string {
  if (depth > 10) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((v) => promptPartToText(v, depth + 1))
      .filter(Boolean)
      .join("\n")
  if (!isRecord(value)) return ""
  const text = stringValue(value.text)
  if (text) return text
  const content = promptPartToText(value.content, depth + 1)
  if (content) return content
  return ""
}

export function systemPromptToText(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value
      .map((v) => promptPartToText(v, 0))
      .filter(Boolean)
      .join("\n\n")
  return promptPartToText(value, 0)
}

function promptSystemText(prompt: PromptLike): string {
  const system = prompt.filter((m) => m.role === "system").map((m) => m.content)
  return systemPromptToText(system.length > 0 ? system.join("\n") : undefined)
}

function cappedMaxTokens(value: unknown): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_PROVIDER_MAX_TOKENS
  return Math.min(n, DEFAULT_PROVIDER_MAX_TOKENS)
}

function reasoningEffortFor(providerOptions: unknown, modelId?: string): string | undefined {
  try {
    const effort = mappedReasoningEffort(
      {
        reasoning: modelId ? isReasoningModel(modelId) : true,
        thinkingLevelMap: modelId ? thinkingMetadataForModel(modelId)?.thinkingLevelMap : undefined,
      },
      { reasoning: resolveProviderReasoning(providerOptions, "commandcode") },
    )
    return effort
  } catch {
    return undefined
  }
}

function dataToBase64(data: unknown): string | undefined {
  if (typeof data === "string") return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64")
  if (ArrayBuffer.isView(data)) return Buffer.from(data as unknown as Uint8Array).toString("base64")
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("base64")
  return undefined
}

function toDataUrl(data: unknown, mediaType: unknown): string | undefined {
  const mime = stringValue(mediaType) ?? "application/octet-stream"
  const raw = dataToBase64(data)
  if (!raw || raw.length === 0) return undefined
  if (raw.startsWith("data:")) return raw
  return `data:${mime};base64,${raw}`
}

function filePartToOpenAIImageUrl(
  part: Record<string, unknown>,
): { type: "image_url"; image_url: { url: string } } | undefined {
  const url = toDataUrl(part.data ?? part.image, part.mediaType ?? part.mimeType)
  if (!url) return undefined
  return { type: "image_url", image_url: { url } }
}

function filePartToAnthropicImage(
  part: Record<string, unknown>,
): { type: "image"; source: { type: "base64"; media_type: string; data: string } } | undefined {
  const mime = stringValue(part.mediaType) ?? stringValue(part.mimeType) ?? "image/png"
  let b64: string | undefined
  const raw = part.data ?? part.image
  if (typeof raw === "string") {
    if (raw.startsWith("data:")) {
      const after = raw.split(";base64,")[1]
      b64 = after ?? raw
      const mimeFromUrl = raw.slice(5).split(";")[0]
      if (mimeFromUrl) {
        // prefer mime from data URL if present
        return { type: "image", source: { type: "base64", media_type: mimeFromUrl, data: b64 } }
      }
    } else {
      b64 = raw
    }
  } else {
    b64 = dataToBase64(raw)
  }
  if (!b64) return undefined
  return { type: "image", source: { type: "base64", media_type: mime, data: b64 } }
}

function textFromPart(part: Record<string, unknown>): string {
  return stringValue(part.text) ?? ""
}

function openAIUserContent(content: unknown, allowImages: boolean): unknown {
  if (typeof content === "string") return content
  const parts = recordArray(content)
  assertProviderContentParts(parts, "user messages")
  const hasImages = parts.some(isImageFilePart)
  if (!hasImages) {
    const texts = parts.filter((p) => p.type === "text").map(textFromPart)
    if (parts.every((p) => p.type === "text")) return texts.join("\n")
    const out: unknown[] = []
    for (const p of parts) {
      if (p.type === "text") out.push({ type: "text", text: textFromPart(p) })
      else if (isImageFilePart(p)) {
        if (!allowImages) throw imageContentError("user messages")
        const img = filePartToOpenAIImageUrl(p)
        if (img) out.push(img)
      }
    }
    return out
  }
  if (!allowImages) throw imageContentError("user messages")
  const out: unknown[] = []
  for (const p of parts) {
    if (p.type === "text") out.push({ type: "text", text: textFromPart(p) })
    else if (isImageFilePart(p)) {
      const img = filePartToOpenAIImageUrl(p)
      if (img) out.push(img)
    }
  }
  return out
}

function anthropicUserContent(content: unknown, allowImages: boolean): unknown {
  if (typeof content === "string") return content
  const parts = recordArray(content)
  assertProviderContentParts(parts, "user messages")
  const hasImages = parts.some(isImageFilePart)
  // Anthropic docs show string content for simple text: "Count to 5."
  // Return string for single text-only part to match documented shape, array otherwise
  if (!hasImages && parts.length === 1 && parts[0]?.type === "text") {
    return textFromPart(parts[0] as Record<string, unknown>)
  }
  if (!hasImages && parts.every((p) => p.type === "text")) {
    // Join multiple text parts with newline — provider accepts string for simple cases
    const texts = parts.map((p) => textFromPart(p as Record<string, unknown>)).filter(Boolean)
    if (texts.length === 1) return texts[0]
    // For multiple texts, keep array form to preserve structure
  }
  const out: unknown[] = []
  for (const p of parts) {
    if (p.type === "text") out.push({ type: "text", text: textFromPart(p) })
    else if (isImageFilePart(p)) {
      if (!allowImages) throw imageContentError("user messages")
      const img = filePartToAnthropicImage(p)
      if (img) out.push(img)
    }
  }
  return out
}

function openAITools(tools: unknown): unknown[] | undefined {
  if (!tools) return undefined
  let entries: Array<[string, unknown]>
  if (Array.isArray(tools)) {
    entries = (tools as Array<Record<string, unknown>>).map((t) => [
      stringValue((t as Record<string, unknown>).name) ?? "",
      t,
    ])
  } else if (isRecord(tools)) {
    entries = Object.entries(tools as Record<string, unknown>)
  } else {
    return undefined
  }
  if (entries.length === 0) return undefined
  return entries.map(([name, tool]) => {
    const rec = isRecord(tool) ? tool : {}
    const description = stringValue(rec.description)
    const parameters = rec.parameters ?? rec.inputSchema ?? {}
    return {
      type: "function",
      function: {
        name,
        description,
        parameters: toJsonSchema(parameters),
      },
    }
  })
}

function anthropicTools(tools: unknown): unknown[] | undefined {
  if (!tools) return undefined
  let entries: Array<[string, unknown]>
  if (Array.isArray(tools)) {
    entries = (tools as Array<Record<string, unknown>>).map((t) => [
      stringValue((t as Record<string, unknown>).name) ?? "",
      t,
    ])
  } else if (isRecord(tools)) {
    entries = Object.entries(tools as Record<string, unknown>)
  } else {
    return undefined
  }
  if (entries.length === 0) return undefined
  return entries.map(([name, tool]) => {
    const rec = isRecord(tool) ? tool : {}
    const description = stringValue(rec.description)
    const parameters = rec.parameters ?? rec.inputSchema ?? {}
    return {
      name,
      description,
      input_schema: toJsonSchema(parameters),
    }
  })
}

function promptToOpenAIMessages(prompt: PromptLike, allowImages: boolean): unknown[] {
  const out: unknown[] = []
  const system = promptSystemText(prompt)
  if (system) out.push({ role: "system", content: system })

  const pairedIds = completeToolCallIds(prompt)

  for (const message of prompt) {
    if (message.role === "system") continue
    if (message.role === "user") {
      out.push({ role: "user", content: openAIUserContent(message.content, allowImages) })
    } else if (message.role === "assistant") {
      const parts = recordArray(message.content)
      const toolCalls = parts
        .filter((p) => p.type === "tool-call")
        .filter((p) => {
          const id = stringValue(p.toolCallId)
          return id ? pairedIds.has(id) : false
        })
      const texts = parts
        .filter((p) => p.type === "text")
        .map(textFromPart)
        .filter(Boolean)
      if (toolCalls.length > 0) {
        const content = texts.length > 0 ? texts.join("\n") : null
        out.push({
          role: "assistant",
          content,
          tool_calls: toolCalls.map((p) => ({
            id: stringValue(p.toolCallId) ?? "",
            type: "function",
            function: {
              name: stringValue(p.toolName) ?? "",
              arguments: JSON.stringify(recordOrEmpty(p.input ?? p.args ?? p.arguments)),
            },
          })),
        })
      } else if (texts.length > 0) {
        out.push({ role: "assistant", content: texts.join("\n") })
      }
    } else if (message.role === "tool") {
      const toolContent = recordArray(message.content)
      assertProviderContentParts(toolContent, "tool results")
      for (const content of toolContent) {
        const toolCallId = stringValue(content.toolCallId) ?? ""
        if (!pairedIds.has(toolCallId)) continue
        const output = unwrapToolResult(content.result ?? content.output)
        out.push({ role: "tool", tool_call_id: toolCallId, content: output })

        const images = imageParts(content)
        if (images.length > 0) {
          if (!allowImages) throw imageContentError("tool results")
          out.push({
            role: "user",
            content: images
              .map((p) => filePartToOpenAIImageUrl(p as Record<string, unknown>))
              .filter(Boolean),
          })
        }
      }
    }
  }
  return out
}

function promptToAnthropicMessages(prompt: PromptLike, allowImages: boolean): unknown[] {
  const out: unknown[] = []
  const pairedIds = completeToolCallIds(prompt)

  for (const message of prompt) {
    if (message.role === "system") continue
    if (message.role === "user") {
      out.push({ role: "user", content: anthropicUserContent(message.content, allowImages) })
    } else if (message.role === "assistant") {
      const parts = recordArray(message.content)
      const content: unknown[] = []
      for (const p of parts) {
        if (p.type === "text") {
          const text = textFromPart(p)
          if (text) content.push({ type: "text", text })
        } else if (p.type === "tool-call") {
          const id = stringValue(p.toolCallId)
          if (!id || !pairedIds.has(id)) continue
          content.push({
            type: "tool_use",
            id,
            name: stringValue(p.toolName) ?? "",
            input: recordOrEmpty(p.input ?? p.args ?? p.arguments),
          })
        }
      }
      if (content.length > 0) out.push({ role: "assistant", content })
    } else if (message.role === "tool") {
      const toolContent = recordArray(message.content)
      assertProviderContentParts(toolContent, "tool results")
      for (const content of toolContent) {
        const toolCallId = stringValue(content.toolCallId) ?? ""
        if (!pairedIds.has(toolCallId)) continue
        const output = unwrapToolResult(content.result ?? content.output)
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolCallId, content: output }],
        })

        const images = imageParts(content)
        if (images.length > 0) {
          if (!allowImages) throw imageContentError("tool results")
          out.push({
            role: "user",
            content: images
              .map((p) => filePartToAnthropicImage(p as Record<string, unknown>))
              .filter(Boolean),
          })
        }
      }
    }
  }
  return out
}

export interface ProviderRequestOptions {
  prompt: PromptLike
  model?: string
  maxOutputTokens?: number
  providerOptions?: unknown
  tools?: unknown
  allowImages?: boolean
  systemPrompt?: unknown
}

/**
 * OpenAI Chat Completions body for POST /provider/v1/chat/completions.
 * Docs: https://commandcode.ai/docs/provider#quickstart / #streaming — follows
 * OpenAI schema; streaming example shows stream:true + stream_options:{include_usage:true}.
 * Provider FAQ: text + images only; max_tokens honoured for both transports (capped 64k).
 * reasoning_effort is CLI extension via reasoning.ts (not in provider docs), byte-equivalent to shared helpers.
 */
function buildOpenAIBody(options: ProviderRequestOptions): Record<string, unknown> {
  const prompt = options.prompt ?? []
  const allowImages = options.allowImages ?? false
  if (!allowImages) assertTextOnlyMessages(prompt)
  const messages = promptToOpenAIMessages(prompt, allowImages)
  const body: Record<string, unknown> = {
    model: options.model ?? "",
    stream: true,
    messages,
  }
  if (options.tools) {
    const t = openAITools(options.tools)
    if (t) body.tools = t
  }
  // Anthropic requires max_tokens; for OpenAI we set capped default to honour #52
  // (byte-equivalent to shared cappedMaxTokens). Provider models list shows context_length up to 1M
  // but transport caps at DEFAULT_PROVIDER_MAX_TOKENS.
  const maxTokens = cappedMaxTokens(options.maxOutputTokens)
  body.max_tokens = maxTokens
  // System is already inside messages for OpenAI, but also accept explicit systemPrompt
  const explicitSystem = systemPromptToText(options.systemPrompt)
  if (explicitSystem && !prompt.some((m) => m.role === "system")) {
    body.messages = [{ role: "system", content: explicitSystem }, ...messages]
  }
  const effort = reasoningEffortFor(options.providerOptions, options.model)
  if (effort) body.reasoning_effort = effort
  // OpenAI streaming usage needs stream_options — doc streaming example includes it
  body.stream_options = { include_usage: true }
  return body
}

/**
 * Anthropic Messages body for POST /provider/v1/messages.
 * Docs: https://commandcode.ai/docs/provider — follows Anthropic schema; system is
 * top-level string (not in messages), stream:true, max_tokens required (we default/cap 64k).
 * reasoning_effort same CLI extension as OpenAI path.
 */
function buildAnthropicBody(options: ProviderRequestOptions): Record<string, unknown> {
  const prompt = options.prompt ?? []
  const allowImages = options.allowImages ?? false
  if (!allowImages) assertTextOnlyMessages(prompt)
  const system = promptSystemText(prompt) || systemPromptToText(options.systemPrompt)
  const messages = promptToAnthropicMessages(prompt, allowImages)
  const body: Record<string, unknown> = {
    model: options.model ?? "",
    stream: true,
    messages,
  }
  if (system) body.system = system
  if (options.tools) {
    const t = anthropicTools(options.tools)
    if (t) body.tools = t
  }
  const maxTokens = cappedMaxTokens(options.maxOutputTokens)
  body.max_tokens = maxTokens
  const effort = reasoningEffortFor(options.providerOptions, options.model)
  if (effort) body.reasoning_effort = effort
  return body
}

// Primary codec helpers — naming follows spec sketch but aliases are provided
export function messagesToOpenAI(
  prompt: PromptLike,
  options: Omit<ProviderRequestOptions, "prompt"> & { prompt?: PromptLike } = {},
): Record<string, unknown> {
  const p = (prompt as unknown as PromptLike) ?? options.prompt ?? []
  // Support both call shapes: messagesToOpenAI(prompt, opts) and messagesToOpenAI({prompt, model, ...})
  if (Array.isArray(prompt) && isRecord(options) && "prompt" in options) {
    // Called as messagesToOpenAI({ prompt, model, ... })
    return buildOpenAIBody(options as ProviderRequestOptions)
  }
  if (Array.isArray(prompt)) {
    return buildOpenAIBody({ prompt: p, ...options })
  }
  // Called as messagesToOpenAI(optionsObject)
  return buildOpenAIBody(prompt as unknown as ProviderRequestOptions)
}

export function messagesToAnthropic(
  prompt: PromptLike,
  options: Omit<ProviderRequestOptions, "prompt"> & { prompt?: PromptLike } = {},
): Record<string, unknown> {
  const p = (prompt as unknown as PromptLike) ?? options.prompt ?? []
  if (Array.isArray(prompt) && isRecord(options) && "prompt" in options) {
    return buildAnthropicBody(options as ProviderRequestOptions)
  }
  if (Array.isArray(prompt)) {
    return buildAnthropicBody({ prompt: p, ...options })
  }
  return buildAnthropicBody(prompt as unknown as ProviderRequestOptions)
}

// Canonical codec entry points: messagesToOpenAI / messagesToAnthropic.
export { openAITools, anthropicTools }
