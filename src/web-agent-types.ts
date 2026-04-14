import type { AgentMachineState } from "./agent-machine"
import type { TodoItem } from "./todo-types"

export type AgentPhase =
    | "idle"
    | "thinking"
    | "tool-calling"
    | "complete"
    | "error"

export interface AgentMessage {
    id: string
    role: "user" | "assistant" | "tool"
    content: string
    diagnosticLevel?: "error" | "warning"
    diagnosticSource?: "agent-feedback"
    toolName?: string
    toolSuccess?: boolean
    reasoning?: string
    rawContent?: string
    timestamp: number
}

export interface AgentState {
    phase: AgentPhase
    messages: AgentMessage[]
    streamingContent: string
    actionCount: number
    error: string | null
    activeToolName: string | null
    todoItems: TodoItem[]
}

export function createInitialWebAgentState(): AgentState {
    return {
        phase: "idle",
        messages: [],
        streamingContent: "",
        actionCount: 0,
        error: null,
        activeToolName: null,
        todoItems: [],
    }
}

export function machineStateToWebAgentPhase(
    state: AgentMachineState,
): AgentPhase {
    switch (state) {
        case "idle":
            return "idle"
        case "prompting":
        case "analyzing":
            return "thinking"
        case "executing":
        case "updating":
            return "tool-calling"
        case "done":
            return "complete"
        case "failed":
            return "error"
    }
}

export function createWebAgentMessageIdGenerator(
    prefix = "msg",
): () => string {
    let counter = 0

    return () => `${prefix}-${Date.now()}-${++counter}`
}