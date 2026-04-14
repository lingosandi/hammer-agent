import { describe, expect, test } from "vitest"

import {
    ToolCallSchema,
    LLMResponseSchema,
} from "../src/schemas"

describe("ToolCallSchema", () => {
    test("accepts valid tool calls", () => {
        const result = ToolCallSchema.safeParse({
            name: "Read",
            parameters: { path: "file.ts" },
        })
        expect(result.success).toBe(true)
    })

    test("accepts explicit bash tool calls", () => {
        const result = ToolCallSchema.safeParse({
            kind: "bash",
            name: "Bash",
            parameters: { command: "exit 0" },
        })
        expect(result.success).toBe(true)
    })

    test("rejects removed tool field", () => {
        const result = ToolCallSchema.safeParse({
            tool: "Write",
            parameters: { path: "out.txt", content: "hello" },
        })
        expect(result.success).toBe(false)
    })

    test("rejects Bash masquerading as a concrete tool name", () => {
        const result = ToolCallSchema.safeParse({
            name: "Bash",
            parameters: { command: "pwd" },
        })

        expect(result.success).toBe(false)
    })

    test("accepts Bash when the kind is explicit", () => {
        const result = ToolCallSchema.safeParse({
            kind: "bash",
            name: "Bash",
            parameters: { command: "pwd" },
        })

        expect(result.success).toBe(true)
    })
})

describe("LLMResponseSchema", () => {
    test("accepts minimal valid responses", () => {
        const result = LLMResponseSchema.safeParse({
            outcome: "continue",
            reasoning: "Working on it",
        })
        expect(result.success).toBe(true)
    })

    test("accepts selectedToolCall", () => {
        const result = LLMResponseSchema.safeParse({
            outcome: "continue",
            selectedToolCall: { name: "Read", parameters: { path: "f.ts" } },
        })
        expect(result.success).toBe(true)
    })

    test("rejects removed tool_call and tool_calls fields", () => {
        expect(LLMResponseSchema.safeParse({
            outcome: "continue",
            tool_call: { name: "Read", parameters: { path: "f.ts" } },
        }).success).toBe(false)

        expect(LLMResponseSchema.safeParse({
            outcome: "continue",
            tool_calls: [{ name: "Read", parameters: {} }],
        }).success).toBe(false)
    })

    test("rejects unexpected extra fields", () => {
        const result = LLMResponseSchema.safeParse({
            outcome: "continue",
            reasoning: "test",
            custom_field: "preserved",
        })
        expect(result.success).toBe(false)
    })
})
