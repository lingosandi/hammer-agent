import { describe, expect, test } from "vitest"
import {
    PendingAgentMessageBuffer,
    createToolAgentMessage,
    applyInitialWebAgentRunState,
    applyIdleWebAgentState,
} from "../src/web-runtime-tooling"
import type { AgentMessage } from "../src/web-agent-types"

describe("PendingAgentMessageBuffer", () => {
    test("starts empty", () => {
        const buffer = new PendingAgentMessageBuffer<string>()
        const taken = buffer.takeForRun(1, () => true)
        expect(taken).toEqual([])
    })

    test("push and takeForRun retrieves messages", () => {
        const buffer = new PendingAgentMessageBuffer<string>()
        buffer.push("msg1")
        buffer.push("msg2")

        const taken = buffer.takeForRun(1, () => true)
        expect(taken).toEqual(["msg1", "msg2"])
    })

    test("takeForRun clears buffer", () => {
        const buffer = new PendingAgentMessageBuffer<string>()
        buffer.push("msg1")

        buffer.takeForRun(1, () => true)
        const secondTake = buffer.takeForRun(1, () => true)
        expect(secondTake).toEqual([])
    })

    test("takeForRun returns empty when run is not active", () => {
        const buffer = new PendingAgentMessageBuffer<string>()
        buffer.push("msg1")

        const taken = buffer.takeForRun(1, () => false)
        expect(taken).toEqual([])
    })

    test("takeForRun preserves messages when run is not active", () => {
        const buffer = new PendingAgentMessageBuffer<string>()
        buffer.push("msg1")

        buffer.takeForRun(1, () => false)
        // Messages should still be in the buffer
        const taken = buffer.takeForRun(1, () => true)
        expect(taken).toEqual(["msg1"])
    })

    test("clear empties the buffer", () => {
        const buffer = new PendingAgentMessageBuffer<string>()
        buffer.push("msg1")
        buffer.push("msg2")
        buffer.clear()

        const taken = buffer.takeForRun(1, () => true)
        expect(taken).toEqual([])
    })

    test("takeForRun checks correct runId", () => {
        const buffer = new PendingAgentMessageBuffer<string>()
        buffer.push("msg1")

        const taken = buffer.takeForRun(42, (id) => id === 42)
        expect(taken).toEqual(["msg1"])
    })
})

describe("createToolAgentMessage", () => {
    test("creates tool message with required fields", () => {
        const msg = createToolAgentMessage({
            id: "msg-1",
            name: "ReadFile",
            content: "file contents here",
            success: true,
        })

        expect(msg.id).toBe("msg-1")
        expect(msg.role).toBe("tool")
        expect(msg.content).toBe("file contents here")
        expect(msg.toolName).toBe("ReadFile")
        expect(msg.toolSuccess).toBe(true)
        expect(msg.timestamp).toBeTypeOf("number")
    })

    test("uses provided timestamp", () => {
        const msg = createToolAgentMessage({
            id: "msg-1",
            name: "Bash",
            content: "output",
            success: false,
            timestamp: 12345,
        })
        expect(msg.timestamp).toBe(12345)
    })

    test("creates failed tool message", () => {
        const msg = createToolAgentMessage({
            id: "msg-2",
            name: "Write",
            content: "permission denied",
            success: false,
        })
        expect(msg.toolSuccess).toBe(false)
    })
})

describe("applyInitialWebAgentRunState", () => {
    test("appends user message and resets state", () => {
        const userMessage: AgentMessage = {
            id: "msg-1",
            role: "user",
            content: "hello",
            timestamp: Date.now(),
        }

        const state = {
            phase: "idle" as const,
            messages: [] as AgentMessage[],
            streamingContent: "leftover",
            error: "old error",
            activeToolName: "OldTool",
            actionCount: 0,
            todoItems: [],
        }

        const result = applyInitialWebAgentRunState(state, userMessage)
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0]).toBe(userMessage)
        expect(result.streamingContent).toBe("")
        expect(result.error).toBeNull()
        expect(result.activeToolName).toBeNull()
    })

    test("preserves existing messages", () => {
        const existing: AgentMessage = {
            id: "msg-0",
            role: "assistant",
            content: "previous",
            timestamp: 1,
        }
        const newMsg: AgentMessage = {
            id: "msg-1",
            role: "user",
            content: "new",
            timestamp: 2,
        }

        const state = {
            phase: "idle" as const,
            messages: [existing],
            streamingContent: "",
            error: null,
            activeToolName: null,
            actionCount: 1,
            todoItems: [],
        }

        const result = applyInitialWebAgentRunState(state, newMsg)
        expect(result.messages).toHaveLength(2)
    })
})

describe("applyIdleWebAgentState", () => {
    test("resets to idle state", () => {
        const state = {
            phase: "tool-calling" as const,
            messages: [] as AgentMessage[],
            streamingContent: "partial output",
            activeToolName: "SomeTool",
            error: null,
            actionCount: 5,
            todoItems: [],
        }

        const result = applyIdleWebAgentState(state)
        expect(result.phase).toBe("idle")
        expect(result.streamingContent).toBe("")
        expect(result.activeToolName).toBeNull()
    })
})
