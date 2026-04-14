import type { AgentLoopCallbacks } from "./agent-loop"
import type { AgentMachineState } from "./agent-machine"
import type { ToolDefinition, ToolResult } from "./types"
import { formatToolCallAsUnixCommand } from "./unix-tooling"
import type { AgentMessage } from "./web-agent-types"
import type { WebToolLoopRuntimeStateLike } from "./web-tool-loop-agent-runtime"

export class PendingAgentMessageBuffer<TMessage> {
    private messages: TMessage[] = []

    push(message: TMessage): void {
        this.messages.push(message)
    }

    clear(): void {
        this.messages = []
    }

    takeForRun(
        runId: number,
        isRunActive: (runId: number) => boolean,
    ): TMessage[] {
        if (!isRunActive(runId) || this.messages.length === 0) {
            return []
        }

        const pendingMessages = this.messages
        this.messages = []
        return pendingMessages
    }
}

export function createToolAgentMessage(options: {
    id: string
    name: string
    content: string
    success: boolean
    timestamp?: number
}): AgentMessage {
    return {
        id: options.id,
        role: "tool",
        content: options.content,
        toolName: options.name,
        toolSuccess: options.success,
        timestamp: options.timestamp ?? Date.now(),
    }
}

export interface CreateWebToolLoopCallbacksOptions {
    getToolDefinitions: () => ToolDefinition[]
    updateActiveToolName: (activeToolName: string | null) => void
    onToolCompleteMessage: (
        name: string,
        result: ToolResult,
        truncatedResult: string,
    ) => void
    onPhaseChange: (state: AgentMachineState) => void
}

export function applyInitialWebAgentRunState<
    TState extends WebToolLoopRuntimeStateLike<TMessage>,
    TMessage extends AgentMessage,
>(state: TState, userMessage: TMessage): TState {
    return {
        ...state,
        messages: [...state.messages, userMessage],
        streamingContent: "",
        error: null,
        activeToolName: null,
    }
}

export function applyIdleWebAgentState<
    TState extends WebToolLoopRuntimeStateLike,
>(state: TState): TState {
    return {
        ...state,
        phase: "idle",
        streamingContent: "",
        activeToolName: null,
    }
}

export function createWebToolLoopCallbacks(
    options: CreateWebToolLoopCallbacksOptions,
): AgentLoopCallbacks {
    return {
        onToolStart: (name, parameters) => {
            options.updateActiveToolName(
                formatToolCallAsUnixCommand(
                    { name, parameters },
                    options.getToolDefinitions(),
                ) ?? name,
            )
        },
        onToolComplete: (name, result, truncatedResult) => {
            options.onToolCompleteMessage(name, result, truncatedResult)
            options.updateActiveToolName(null)
        },
        onPhaseChange: options.onPhaseChange,
    }
}