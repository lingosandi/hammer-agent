import { describe, expect, test, vi } from "vitest"
import {
    BaseValidationEnforcer,
    createConversationSink,
    type ConversationSink,
} from "../src/validation-enforcer"

function createMockSink() {
    const messages: Array<{ role: string; content: string }> = []
    const sink: ConversationSink = {
        addMessage: async (role, content) => {
            messages.push({ role, content })
        },
    }
    return { sink, messages }
}

class TestEnforcer extends BaseValidationEnforcer {
    public warnings: string[] = []
    public errors: string[] = []

    protected logWarning(message: string): void {
        this.warnings.push(message)
    }

    protected logError(message: string): void {
        this.errors.push(message)
    }
}

describe("createConversationSink", () => {
    test("wraps a function into a ConversationSink", async () => {
        const calls: Array<{ role: string; content: string }> = []
        const sink = createConversationSink((role, content) => {
            calls.push({ role, content })
        })

        await sink.addMessage("user", "hello")
        expect(calls).toEqual([{ role: "user", content: "hello" }])
    })

    test("wraps async function", async () => {
        const sink = createConversationSink(async () => {})
        await expect(sink.addMessage("system", "test")).resolves.toBeUndefined()
    })
})

describe("BaseValidationEnforcer", () => {
    test("surfaceError adds error message to sink", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        const result = await enforcer.handleValidationError(new Error("bad format"))
        expect(messages).toHaveLength(1)
        expect(messages[0].role).toBe("user")
        expect(messages[0].content).toContain("ERROR")
    })

    test("handleValidationError returns EnforcerResult", async () => {
        const { sink } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        const result = await enforcer.handleValidationError(new Error("bad"))
        expect(result.errorMessage).toBeTruthy()
        expect(result.lastToolResult).toBeTruthy()

        const parsed = JSON.parse(result.lastToolResult)
        expect(parsed.success).toBe(false)
        expect(parsed.error).toBeTruthy()
    })

    test("handleValidationError strips VALIDATION_ERROR prefix", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        await enforcer.handleValidationError(new Error("VALIDATION_ERROR: too many blocks"))
        expect(messages[0].content).toContain("too many blocks")
    })

    test("handleValidationError logs warning", async () => {
        const { sink } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        await enforcer.handleValidationError(new Error("parse error"))
        expect(enforcer.warnings).toHaveLength(1)
        expect(enforcer.warnings[0]).toContain("parse error")
    })

    test("handleApiError surfaces LLM API error", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        const result = await enforcer.handleApiError(new Error("rate limited"))
        expect(result.errorMessage).toContain("LLM API error")
        expect(result.errorMessage).toContain("rate limited")
        expect(messages[0].content).toContain("rate limited")
    })

    test("handleApiError logs error", async () => {
        const { sink } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        await enforcer.handleApiError(new Error("500"))
        expect(enforcer.errors).toHaveLength(1)
    })

    test("handleFatalError surfaces fatal error", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        const result = await enforcer.handleFatalError(new Error("out of memory"))
        expect(result.errorMessage).toContain("Fatal agent error")
        expect(result.errorMessage).toContain("out of memory")
    })

    test("handleFatalError accepts string", async () => {
        const { sink } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        const result = await enforcer.handleFatalError("crashed")
        expect(result.errorMessage).toContain("crashed")
    })

    test("handleMissingToolCall warns about wasted turn", async () => {
        const { sink, messages } = createMockSink()
        const enforcer = new TestEnforcer(sink)

        await enforcer.handleMissingToolCall(5)
        expect(messages).toHaveLength(1)
        expect(messages[0].content).toContain("WARNING")
        expect(messages[0].content).toContain("wasted")
        expect(enforcer.warnings).toHaveLength(1)
    })
})
