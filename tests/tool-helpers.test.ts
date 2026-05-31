import { describe, expect, test } from "vitest"

import {
    truncateHead,
    truncateTail,
    executeToolSafe,
    formatToolResultMessage,
    parseToolResultMessage,
} from "../src/tool-helpers"
import type { ToolCall } from "../src/types"

describe("tool-helpers", () => {
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

    test("formatToolResultMessage uses pi-style truncation notice for large read-like outputs", () => {
        const toolCall: ToolCall = {
            kind: "tool",
            name: "ReadScenegraph",
            parameters: { id: "root" },
        }

        const bigOutput = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`).join("\n")
        const formatted = formatToolResultMessage(toolCall, {
            success: true,
            output: bigOutput,
        })

        expect(formatted).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]")
        expect(formatted).toContain("Line 1")
        expect(formatted).toContain("Line 2000")
        expect(formatted).not.toContain("Use more specific commands")
    })

    test("formatToolResultMessage keeps tail for large bash outputs", () => {
        const toolCall: ToolCall = {
            kind: "bash",
            name: "Bash",
            parameters: { command: "cat huge.log" },
        }

        const bigOutput = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`).join("\n")
        const formatted = formatToolResultMessage(toolCall, {
            success: true,
            output: bigOutput,
            command: "cat huge.log",
        })

        expect(formatted).toContain("[Showing lines 501-2500 of 2500.]")
        expect(formatted).toContain("Line 2500")
        expect(formatted).not.toContain("Line 1\nLine 2")
    })

    test("truncateHead reports firstLineExceedsLimit", () => {
        const result = truncateHead("éé\nabc", { maxBytes: 3, maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.truncatedBy).toBe("bytes")
        expect(result.firstLineExceedsLimit).toBe(true)
        expect(result.content).toBe("")
    })

    test("truncateTail preserves UTF-8 boundaries for partial line tails", () => {
        const result = truncateTail("aé🙂b", { maxBytes: 5, maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.truncatedBy).toBe("bytes")
        expect(result.lastLinePartial).toBe(true)
        expect(result.content).toBe("🙂b")
    })
})
