// tests/converters.test.ts — AI SDK v3 messages → Command Code payload (PLAN #2 Part B)
import { messagesToCC, toolsToJson, systemPromptToText } from "../src/provider/converters.js"
import { MODEL_SNAPSHOT } from "../src/catalog/snapshot.js"
import { isReasoningModel } from "../src/provider/reasoning.js"
import { assert, assertEqual, rejects, run } from "./harness.js"

/**
 * A reasoning-capable, non-Claude model, derived from the shipped Snapshot. A
 * literal id would pin an upstream-owned value and turn red the day that model
 * is retired or goes `hidden` (the 2026-11-05 catalog-refresh failure).
 */
const REASONING_MODEL = MODEL_SNAPSHOT.find(
  (model) => isReasoningModel(model.id) && !model.id.startsWith("claude-"),
)?.id
if (REASONING_MODEL === undefined) {
  throw new Error("the Snapshot must ship at least one reasoning-capable model")
}

run([
  [
    "maps text user/assistant turns",
    () => {
      const out = messagesToCC([
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ])
      assertEqual(out, [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ])
    },
  ],

  [
    "legacy wire replays assistant reasoning for a reasoning model",
    () => {
      // The legacy /alpha/generate gateway serves the same provider contracts
      // as the Provider API: reasoning models answer HTTP 400 when an earlier
      // assistant turn's reasoning is missing. The CLI wire spells it as a
      // reasoning content part, which is what the official client sends.
      const out = messagesToCC(
        [
          { role: "user", content: [{ type: "text", text: "Hello" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "User just said hello; greet them." },
              { type: "text", text: "Hello! How can I help you today?" },
            ],
          },
          { role: "user", content: [{ type: "text", text: "Tell me more" }] },
        ],
        { model: REASONING_MODEL },
      )
      assertEqual(out, [
        { role: "user", content: [{ type: "text", text: "Hello" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "User just said hello; greet them." },
            { type: "text", text: "Hello! How can I help you today?" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Tell me more" }] },
      ])
    },
  ],

  [
    "legacy wire drops reasoning for a non-reasoning model",
    () => {
      const out = messagesToCC(
        [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "secret chain" },
              { type: "text", text: "visible" },
            ],
          },
        ],
        { model: "moonshotai/Kimi-K2.5" },
      )
      assertEqual(out, [{ role: "assistant", content: [{ type: "text", text: "visible" }] }])
    },
  ],

  [
    "legacy wire drops reasoning when the model is unknown",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "secret chain" },
            { type: "text", text: "visible" },
          ],
        },
      ])
      assertEqual(out, [{ role: "assistant", content: [{ type: "text", text: "visible" }] }])
    },
  ],

  [
    "legacy wire replays reasoning before a completed tool call",
    () => {
      const out = messagesToCC(
        [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "I should read the file first." },
              { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
            ],
          },
          {
            role: "tool",
            content: [
              { type: "tool-result", toolCallId: "tc1", toolName: "read", result: "file contents" },
            ],
          },
        ],
        { model: "deepseek/deepseek-v4.1-flash" },
      )
      assertEqual(out, [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "I should read the file first." },
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "read",
              output: { type: "text", value: "file contents" },
            },
          ],
        },
      ])
    },
  ],

  [
    "legacy wire drops a reasoning-only assistant turn",
    () => {
      const out = messagesToCC(
        [{ role: "assistant", content: [{ type: "reasoning", text: "just a thought" }] }],
        { model: REASONING_MODEL },
      )
      assertEqual(out, [])
    },
  ],

  [
    "legacy wire synthesizes reasoning for a text-only turn from another model (issue #334)",
    () => {
      // A session started on a non-reasoning model carries no reasoning part
      // for its earlier turns. Continuing it on a reasoning model would
      // otherwise fail with HTTP 400 (`missing messages[N].reasoning_content`):
      // the gateway wants a non-empty reasoning part on every assistant turn
      // with a payload.
      const out = messagesToCC(
        [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "text", text: "Hello!" }] },
          { role: "user", content: [{ type: "text", text: "Tell me more" }] },
        ],
        { model: REASONING_MODEL },
      )
      assertEqual(out, [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "(no reasoning recorded for this earlier turn)" },
            { type: "text", text: "Hello!" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Tell me more" }] },
      ])
    },
  ],

  [
    "legacy wire treats an empty reasoning part as absent and synthesizes one (issue #334)",
    () => {
      // An empty reasoning part is rejected by the gateway just like a missing
      // one, and the replay path skips empty text.
      const out = messagesToCC(
        [
          {
            role: "assistant",
            content: [
              { type: "reasoning", text: "" },
              { type: "text", text: "Hello!" },
            ],
          },
        ],
        { model: REASONING_MODEL },
      )
      assertEqual(out, [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "(no reasoning recorded for this earlier turn)" },
            { type: "text", text: "Hello!" },
          ],
        },
      ])
    },
  ],

  [
    "legacy wire synthesizes reasoning for a tool-bearing turn with none (issue #334)",
    () => {
      // Live verification: the gateway rejects tool-bearing turns without a
      // reasoning part too, despite the issue's initial table claiming an
      // exemption. The placeholder fixes both shapes.
      const out = messagesToCC(
        [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me read that." },
              { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
            ],
          },
          {
            role: "tool",
            content: [
              { type: "tool-result", toolCallId: "tc1", toolName: "read", result: "contents" },
            ],
          },
        ],
        { model: REASONING_MODEL },
      )
      assertEqual(out, [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "(no reasoning recorded for this earlier turn)" },
            { type: "text", text: "Let me read that." },
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "read",
              output: { type: "text", value: "contents" },
            },
          ],
        },
      ])
    },
  ],

  [
    "legacy wire synthesizes reasoning for a tool-call-only turn (issue #334)",
    () => {
      const out = messagesToCC(
        [
          {
            role: "assistant",
            content: [
              { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
            ],
          },
          {
            role: "tool",
            content: [
              { type: "tool-result", toolCallId: "tc1", toolName: "read", result: "contents" },
            ],
          },
        ],
        { model: REASONING_MODEL },
      )
      assertEqual(out, [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "(no reasoning recorded for this earlier turn)" },
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "read",
              output: { type: "text", value: "contents" },
            },
          ],
        },
      ])
    },
  ],

  [
    "legacy wire does not synthesize reasoning for a non-reasoning model (issue #334)",
    () => {
      const out = messagesToCC(
        [{ role: "assistant", content: [{ type: "text", text: "Hello!" }] }],
        { model: "moonshotai/Kimi-K2.5" },
      )
      assertEqual(out, [{ role: "assistant", content: [{ type: "text", text: "Hello!" }] }])
    },
  ],

  [
    "maps tool call + tool result pair",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc1", toolName: "read", args: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "tc1", toolName: "read", result: "file contents" },
          ],
        },
      ])
      assertEqual(out, [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "read",
              output: { type: "text", value: "file contents" },
            },
          ],
        },
      ])
    },
  ],

  [
    "maps tool call input from the AI SDK v3 prompt shape",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "tc1", toolName: "read", result: "file contents" },
          ],
        },
      ])
      assertEqual(out, [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "tc1", toolName: "read", input: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "read",
              output: { type: "text", value: "file contents" },
            },
          ],
        },
      ])
    },
  ],

  [
    "drops tool calls without a paired result",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "read", args: {} }],
        },
      ])
      assertEqual(out, [])
    },
  ],

  [
    "unwraps text tool results",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", args: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "bash",
              output: { type: "text", value: "file1 file2" },
            },
          ],
        },
      ])
      const tool = out[1] as { content: Array<{ output: { value: string } }> }
      assertEqual(tool.content[0].output, { type: "text", value: "file1 file2" })
    },
  ],

  [
    "unwraps error-text tool results",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", args: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "bash",
              output: { type: "error-text", value: "boom" },
              isError: true,
            },
          ],
        },
      ])
      const tool = out[1] as { content: Array<{ output: { type: string; value: string } }> }
      assertEqual(tool.content[0].output, { type: "error-text", value: "boom" })
    },
  ],

  [
    "stringifies json tool results",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", args: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "bash",
              output: { type: "json", value: { files: ["a", "b"] } },
            },
          ],
        },
      ])
      const tool = out[1] as { content: Array<{ output: { type: string; value: string } }> }
      assertEqual(tool.content[0].output, {
        type: "text",
        value: '{"files":["a","b"]}',
      })
    },
  ],

  [
    "unwraps content tool results to text",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", args: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "bash",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "line one" },
                  { type: "file-data", data: "aGk=", mediaType: "image/png" },
                ],
              },
            },
          ],
        },
      ])
      const tool = out[1] as { content: Array<{ output: { value: string } }> }
      assertEqual(tool.content[0].output, { type: "text", value: "line one" })
    },
  ],

  [
    "maps execution-denied tool results to the denial reason",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", args: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "bash",
              output: { type: "execution-denied", reason: "user said no" },
            },
          ],
        },
      ])
      const tool = out[1] as { content: Array<{ output: { type: string; value: string } }> }
      assertEqual(tool.content[0].output, { type: "text", value: "user said no" })
    },
  ],

  [
    "marks error tool results",
    () => {
      const out = messagesToCC([
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "tc1", toolName: "bash", args: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "bash",
              result: "boom",
              isError: true,
            },
          ],
        },
      ])
      const tool = out[1] as { content: Array<{ output: { type: string } }> }
      assertEqual(tool.content[0].output.type, "error-text")
    },
  ],

  [
    "user string content is passed through",
    () => {
      const out = messagesToCC([{ role: "user", content: "plain" }])
      assertEqual(out, [{ role: "user", content: "plain" }])
    },
  ],

  [
    "system prompt flattens to text",
    () => {
      assertEqual(systemPromptToText(["you are", ["a helper"]]), "you are\n\na helper")
    },
  ],

  [
    "tools serialize to CC function schema",
    () => {
      const out = toolsToJson({
        read: {
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      })
      assertEqual(out, [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ])
    },
  ],

  [
    "image parts are forwarded as data URLs when allowed",
    () => {
      const out = messagesToCC(
        [{ role: "user", content: [{ type: "image", image: "aGVsbG8=", mimeType: "image/png" }] }],
        { allowImages: true },
      )
      assertEqual(out, [
        {
          role: "user",
          content: [
            { type: "image", image: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" },
          ],
        },
      ])
    },
  ],

  [
    "image parts throw when not allowed",
    () => {
      rejects(
        Promise.resolve().then(() => {
          messagesToCC([
            {
              role: "user",
              content: [{ type: "image", image: "aGVsbG8=", mimeType: "image/png" }],
            },
          ])
        }),
        /does not support image content/,
      )
    },
  ],
])
