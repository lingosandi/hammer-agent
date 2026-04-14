import { describe, expect, test } from "vitest"
import {
    createInitialWebAgentState,
    machineStateToWebAgentPhase,
    createWebAgentMessageIdGenerator,
} from "../src/web-agent-types"

describe("createInitialWebAgentState", () => {
    test("returns default state", () => {
        const state = createInitialWebAgentState()
        expect(state.phase).toBe("idle")
        expect(state.messages).toEqual([])
        expect(state.streamingContent).toBe("")
        expect(state.actionCount).toBe(0)
        expect(state.error).toBeNull()
        expect(state.activeToolName).toBeNull()
        expect(state.todoItems).toEqual([])
    })
})

describe("machineStateToWebAgentPhase", () => {
    test("maps idle to idle", () => {
        expect(machineStateToWebAgentPhase("idle")).toBe("idle")
    })

    test("maps prompting to thinking", () => {
        expect(machineStateToWebAgentPhase("prompting")).toBe("thinking")
    })

    test("maps analyzing to thinking", () => {
        expect(machineStateToWebAgentPhase("analyzing")).toBe("thinking")
    })

    test("maps executing to tool-calling", () => {
        expect(machineStateToWebAgentPhase("executing")).toBe("tool-calling")
    })

    test("maps updating to tool-calling", () => {
        expect(machineStateToWebAgentPhase("updating")).toBe("tool-calling")
    })

    test("maps done to complete", () => {
        expect(machineStateToWebAgentPhase("done")).toBe("complete")
    })

    test("maps failed to error", () => {
        expect(machineStateToWebAgentPhase("failed")).toBe("error")
    })
})

describe("createWebAgentMessageIdGenerator", () => {
    test("generates unique ids with default prefix", () => {
        const generateId = createWebAgentMessageIdGenerator()
        const id1 = generateId()
        const id2 = generateId()
        expect(id1).toMatch(/^msg-\d+-\d+$/)
        expect(id1).not.toBe(id2)
    })

    test("uses custom prefix", () => {
        const generateId = createWebAgentMessageIdGenerator("custom")
        expect(generateId()).toMatch(/^custom-\d+-\d+$/)
    })

    test("increments counter", () => {
        const generateId = createWebAgentMessageIdGenerator("test")
        const id1 = generateId()
        const id2 = generateId()
        // Extract counter from the end
        const counter1 = Number(id1.split("-").pop())
        const counter2 = Number(id2.split("-").pop())
        expect(counter2).toBe(counter1 + 1)
    })
})
