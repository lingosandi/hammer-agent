import type { AgentMemoryLayer } from "./agent-memory-layer"
import type { LLMClient } from "./llm-client"
import type {
    ChatMessage,
    LLMClientResponse,
} from "./types"

export interface ToolLoopStepExecutorResponse {
    content: string
    finishReason: string
    usage?: LLMClientResponse["usage"]
}

export interface ToolLoopStepExecutorCallbacks {
    onMessagesBuilt?(messages: ChatMessage[]): void
    onToken?(token: string): void
    onComplete?(response: ToolLoopStepExecutorResponse): void
    onStreamError?(error: Error): void
    onLog?(message: string, level: "info" | "warn" | "error"): void
}

export interface ToolLoopStepExecutorOptions<TResult> {
    llmClient: LLMClient
    memoryLayer: Pick<AgentMemoryLayer, "buildMessages">
    systemPrompt: string
    temperature: number
    maxTokens: number
    frequencyPenalty?: number
    presencePenalty?: number
    callbacks?: ToolLoopStepExecutorCallbacks
    parseResponse(response: {
        content: string
        finishReason: string
        usage?: LLMClientResponse["usage"]
        messages: ChatMessage[]
    }): TResult
}

export interface ToolLoopStepExecutionResult<TResult> {
    messages: ChatMessage[]
    response: ToolLoopStepExecutorResponse
    parsed: TResult
}

export async function executeToolLoopStep<TResult>(
    options: ToolLoopStepExecutorOptions<TResult>,
): Promise<ToolLoopStepExecutionResult<TResult>> {
    const messages = options.memoryLayer.buildMessages(options.systemPrompt)
    options.callbacks?.onMessagesBuilt?.(messages)

    const llmResponse = await options.llmClient.chat(
        {
            messages,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            stream: true,
            frequencyPenalty: options.frequencyPenalty,
            presencePenalty: options.presencePenalty,
        },
        {
            onToken: options.callbacks?.onToken,
            onError: options.callbacks?.onStreamError,
            onLog: options.callbacks?.onLog,
        },
    )

    const response: ToolLoopStepExecutorResponse = {
        content: llmResponse.content,
        finishReason: llmResponse.finishReason,
        usage: llmResponse.usage,
    }

    options.callbacks?.onComplete?.(response)

    return {
        messages,
        response,
        parsed: options.parseResponse({
            ...response,
            messages,
        }),
    }
}