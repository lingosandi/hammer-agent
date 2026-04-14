import { describe, expect, test } from "vitest"
import { WebValidationEnforcer } from "../src/web-validation-enforcer"
import type { ConversationSink } from "../src/validation-enforcer"

function createMockSink() {
    const messages: Array<{ role: string; content: string }> = []
    const sink: ConversationSink = {
        addMessage: async (role, content) => {
            messages.push({ role, content })
        },
    }
    return { sink, messages }
}

describe("WebValidationEnforcer", () => {
    test("routes logs to custom onLog callback", async () => {
        const { sink } = createMockSink()
        const logs: Array<{ level: string; message: string }> = []

        const enforcer = new WebValidationEnforcer(sink, {
            onLog: (level, message) => logs.push({ level, message }),
        })

        await enforcer.handleValidationError(new Error("bad format"))
        expect(logs.length).toBeGreaterThanOrEqual(1)
        expect(logs[0].level).toBe("warn")
    })

    test("routes API errors to onLog with error level", async () => {
        const { sink } = createMockSink()
        const logs: Array<{ level: string; message: string }> = []

        const enforcer = new WebValidationEnforcer(sink, {
            onLog: (level, message) => logs.push({ level, message }),
        })

        await enforcer.handleApiError(new Error("rate limit"))
        expect(logs.some((l) => l.level === "error")).toBe(true)
    })

    test("surfaces raw content as assistant message", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new WebValidationEnforcer(sink)

        const error = Object.assign(new Error("validation failed"), {
            rawContent: "I'll check the file now\n---bash---\ncat file.ts",
        })

        await enforcer.handleValidationError(error)
        // Should have assistant message (rawContent) + user message (error surface)
        const assistantMessages = messages.filter((m) => m.role === "assistant")
        expect(assistantMessages).toHaveLength(1)
        expect(assistantMessages[0].content).toContain("cat file.ts")
    })

    test("skips assistant message when rawContent is empty", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new WebValidationEnforcer(sink)

        const error = Object.assign(new Error("validation failed"), {
            rawContent: "   ",
        })

        await enforcer.handleValidationError(error)
        const assistantMessages = messages.filter((m) => m.role === "assistant")
        expect(assistantMessages).toHaveLength(0)
    })

    test("skips assistant message when rawContent is absent", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new WebValidationEnforcer(sink)

        await enforcer.handleValidationError(new Error("no raw content"))
        const assistantMessages = messages.filter((m) => m.role === "assistant")
        expect(assistantMessages).toHaveLength(0)
    })

    test("works without onLog option", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new WebValidationEnforcer(sink)

        // Should not throw
        await enforcer.handleValidationError(new Error("test"))
        expect(messages.length).toBeGreaterThan(0)
    })
})
