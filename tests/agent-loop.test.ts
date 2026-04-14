import { describe, expect, test, vi } from "vitest"

const mock = vi.fn

import {
    AgentLoop,
    type AgentLoopDeps,
    type ConversationAdapter,
} from "../src/agent-loop"
import type { BaseValidationEnforcer } from "../src/validation-enforcer"
import type { ToolCall, ToolResult } from "../src/types"

const bashSegment = (payload: string) => ["---bash---", payload].join("\n")
const exitSuccessSegment = () => bashSegment("exit 0")
const exitFailureSegment = () => bashSegment("exit 1")

function createMockEnforcer(): BaseValidationEnforcer {
    return {
        sink: { addMessage: mock(async () => {}) },
        getState: () => ({}),
        restoreState: () => {},
        handleMissingToolCall: mock(async () => {}),
        handleValidationError: mock(async (error: Error) => ({
            errorMessage: error.message,
            lastToolResult: error.message,
        })),
        handleApiError: mock(async (error: Error) => ({
            errorMessage: error.message,
            lastToolResult: error.message,
        })),
        handleFatalError: mock(async (error: Error | string) => {
            const message = error instanceof Error ? error.message : error
            return {
                errorMessage: `Fatal agent error: ${message}`,
                lastToolResult: `fatal:${message}`,
            }
        }),
    } as unknown as BaseValidationEnforcer
}

function createMockConversation(): ConversationAdapter & {
    messages: Array<{ role: string; content: string }>
} {
    const messages: Array<{ role: string; content: string }> = []

    return {
        messages,
        appendMessage: mock(async (role: "user" | "assistant" | "tool", content: string) => {
            messages.push({ role, content })
        }),
        appendToolMessage: mock(async (content: string) => {
            messages.push({ role: "tool", content })
        }),
        getLastMessageRole: () => messages.at(-1)?.role,
        getLastMessageContent: () => messages.at(-1)?.content,
        triggerCompactionIfNeeded: mock(async () => {}),
    }
}

function createDeps(overrides: Partial<AgentLoopDeps> = {}): AgentLoopDeps {
    return {
        executeTool: mock(async (call: ToolCall): Promise<ToolResult> => ({
            success: true,
            output: `ran ${call.name}`,
        })),
        enforcer: createMockEnforcer(),
        conversation: createMockConversation(),
        ...overrides,
    }
}

describe("AgentLoop", () => {
    test("prepareStep injects a continuation user message", async () => {
        const deps = createDeps()
        const loop = new AgentLoop(deps)

        loop.start("ship it")
        const injected = await loop.prepareStep(3)

        const conversation = deps.conversation as ReturnType<typeof createMockConversation>
        expect(injected).toBe(true)
        expect(loop.machineState).toBe("analyzing")
        expect(conversation.messages.at(-1)?.role).toBe("user")
        expect(conversation.messages.at(-1)?.content).toBe("Continue working on the task. What is your next action?")

        loop.destroy()
    })

    test("processStep appends assistant content and executes tool calls", async () => {
        const deps = createDeps()
        const loop = new AgentLoop(deps)

        loop.start("ship it")
        await loop.prepareStep()

        const result = await loop.processStep({
            outcome: "continue",
            selectedToolCall: { kind: "bash", name: "Bash", parameters: { command: "cat test.ts" } },
            wasTruncated: false,
            rawContent: "Need to inspect the file first",
        })

        const conversation = deps.conversation as ReturnType<typeof createMockConversation>
        expect(result.outcome).toBe("continue")
        expect(result.toolResults).toHaveLength(1)
        expect(conversation.messages.find((m) => m.role === "assistant")?.content).toBe(
            "Need to inspect the file first",
        )
        expect(loop.lastToolResult).toContain("cat test.ts")

        loop.destroy()
    })

    test("processStep honors a trailing finish line when it is the last extracted directive", async () => {
        const enforcer = createMockEnforcer()
        const deps = createDeps({ enforcer })
        const loop = new AgentLoop(deps)

        loop.start("ship it")
        await loop.prepareStep()

        const result = await loop.processStep({
            outcome: "success",
            wasTruncated: false,
            rawContent: [
                "I already have the answer.",
                bashSegment("cat btc.txt"),
                exitSuccessSegment(),
            ].join("\n"),
        })

        expect(result.outcome).toBe("success")
        expect(result.toolResults).toEqual([])
        expect(enforcer.handleValidationError).not.toHaveBeenCalled()
        expect(deps.executeTool).not.toHaveBeenCalled()

        loop.destroy()
    })

    test("processStep does not append terminal failure assistant content to conversation", async () => {
        const deps = createDeps()
        const loop = new AgentLoop(deps)

        loop.start("ship it")
        await loop.prepareStep()

        const result = await loop.processStep({
            outcome: "failure",
            wasTruncated: false,
            rawContent: [
                "I cannot complete this task with the available tools.",
                exitFailureSegment(),
            ].join("\n"),
        })

        const conversation = deps.conversation as ReturnType<typeof createMockConversation>
        expect(result.outcome).toBe("failure")
        expect(conversation.messages.some((message) => message.role === "assistant")).toBe(false)

        loop.destroy()
    })

    test("processStep rejects synthetic continue responses without tool calls as validation errors", async () => {
        const enforcer = createMockEnforcer()
        const deps = createDeps({ enforcer })
        const loop = new AgentLoop(deps)

        loop.start("ship it")
        await loop.prepareStep()

        const result = await loop.processStep({
            outcome: "continue",
            wasTruncated: false,
            rawContent: "I will think a bit longer before acting.",
        })

        expect(result.outcome).toBe("continue")
        expect(result.toolResults).toEqual([])
        expect(enforcer.handleValidationError).toHaveBeenCalled()
        expect(enforcer.handleMissingToolCall).not.toHaveBeenCalled()
        expect(deps.executeTool).not.toHaveBeenCalled()
        const validationError = (enforcer.handleValidationError as ReturnType<typeof mock>).mock.calls[0]?.[0] as
            | Error
            | undefined
        expect(validationError?.message).toContain(
            "Your response did not end with an executable control block.",
        )

        loop.destroy()
    })

    test("processStep success triggers completion callback", async () => {
        const onComplete = mock(() => {})
        const deps = createDeps({ callbacks: { onComplete } })
        const loop = new AgentLoop(deps)

        loop.start("ship it")
        await loop.prepareStep()

        const result = await loop.processStep({
            outcome: "success",
            wasTruncated: false,
        })

        expect(result.outcome).toBe("success")
        expect(onComplete).toHaveBeenCalled()
        expect(loop.machineState).toBe("done")

        loop.destroy()
    })

    test("start enters prompting immediately", () => {
        const loop = new AgentLoop(createDeps())

        loop.start("ship it")

        expect(loop.machineState).toBe("prompting")

        loop.destroy()
    })

    test("handleFatalError uses the shared enforcer surface and stores lastToolResult", async () => {
        const onFail = mock(() => {})
        const enforcer = createMockEnforcer()
        const deps = createDeps({ enforcer, callbacks: { onFail } })
        const loop = new AgentLoop(deps)

        loop.start("ship it")
        await loop.handleFatalError("runtime exploded")

        expect(enforcer.handleFatalError).toHaveBeenCalledWith("runtime exploded")
        expect(loop.machineState).toBe("failed")
        expect(loop.lastToolResult).toBe("fatal:runtime exploded")
        expect(onFail).toHaveBeenCalledTimes(1)

        loop.destroy()
    })
})
