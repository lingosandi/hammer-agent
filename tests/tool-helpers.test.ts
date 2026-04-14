import { describe, expect, test } from "vitest"

import {
    truncateToolResult,
    executeToolSafe,
    formatToolResultMessage,
    parseToolResultMessage,
    MAX_TOOL_RESULT_CHARS,
} from "../src/tool-helpers"
import type { ToolCall } from "../src/types"

describe("tool-helpers", () => {
    test("truncateToolResult leaves short strings untouched", () => {
        expect(truncateToolResult("hello")).toBe("hello")
        expect(truncateToolResult("x".repeat(MAX_TOOL_RESULT_CHARS))).toBe(
            "x".repeat(MAX_TOOL_RESULT_CHARS),
        )
    })

    test("truncateToolResult shortens oversized output", () => {
        const result = truncateToolResult("x".repeat(40000), { strategy: "head-tail" })
        expect(result).toContain("chars truncated")
        expect(result.length).toBeLessThan(40000)
    })

    test("executeToolSafe converts thrown errors into failures", async () => {
        const result = await executeToolSafe(async () => {
            throw new Error("Something broke")
        })

        expect(result.success).toBe(false)
        expect(result.error).toBe("Something broke")
    })

    test("formatToolResultMessage renders unix-style transcripts", () => {
        const toolCall: ToolCall = {
            kind: "bash",
            name: "Bash",
            parameters: { command: "cat package.json | grep version" },
        }

        const formatted = formatToolResultMessage(toolCall, {
            success: true,
            output: '"version": "1.0.0"',
            command: "cat package.json | grep version",
            command_name: "grep",
            route: "Grep",
            duration_ms: 12,
            path: "package.json",
        })

        expect(formatted).toContain("$ cat package.json | grep version")
        expect(formatted).toContain('[meta] tool="grep" route="Grep" path="package.json"')
        expect(formatted).toContain("[exit:0 | 12ms]")
    })

    test("parseToolResultMessage reads transcripts back into metadata", () => {
        const parsed = parseToolResultMessage(
            `$ cat package.json\n{"name":"demo"}\n[meta] tool="cat" route="Read" path="package.json"\n[exit:0 | 9ms]`,
        )

        expect(parsed.success).toBe(true)
        expect(parsed.toolName).toBe("cat")
        expect(parsed.parsed?.path).toBe("package.json")
        expect(parsed.parsed?.output).toContain('"name"')
    })
})
