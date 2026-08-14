// src/provider/converters.ts — AI SDK v3 messages → Command Code payload (PLAN #2 Part B)
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

export { toJsonSchema } from "./json-schema.js"

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
  if (isRecord(value)) return value.type === "image" || value.type === "file" ? [value] : []
  return recordArray(value).filter(
    (part) =>
      part.type === "image" ||
      (part.type === "file" && stringValue(part.mediaType)?.startsWith("image/")),
  )
}

function imageContentError(role: string): Error {
  return new Error(`Selected Command Code model does not support image content in ${role}`)
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
