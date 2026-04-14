/**
 * Shared non-voice tool-loop runtime for Hammer, Magic, Monoslides, and Monospace.
 *
 * This base owns the common runtime seam across non-voice agents: memory
 * bootstrap, static context injection, AgentLoop setup, per-step LLM calls,
 * and parsed step execution.
 */

import {
    AgentLoop,
    type AgentLoopCallbacks,
    type AgentLoopDeps,
    type ConversationAdapter,
    type ParsedStepInput,
    type StepResult,
} from "./agent-loop"
import type { AgentMemoryLayer } from "./agent-memory-layer"
import { LLMClient } from "./llm-client"
import type {
    ChatMessage,
    LLMClientResponse,
    ToolDefinition,
} from "./types"
import type { BaseValidationEnforcer } from "./validation-enforcer"

export interface ToolLoopRuntimeStepContext<TStepInput = undefined> {
    task: string
    actionCount: number
    tools: ToolDefinition[]
    stepInput?: TStepInput
}

export interface ToolLoopRuntimeRunStepOptions<TStepInput = undefined> {
    task: string
    actionCount: number
    signal?: AbortSignal
    stepInput?: TStepInput
}

export interface ToolLoopRuntimeLLMRequest {
    messages: ChatMessage[]
    temperature?: number
    maxTokens?: number
    frequencyPenalty?: number
    presencePenalty?: number
    onToken?: (token: string) => void | boolean
    normalizeResponseContent?: (content: string) => string
}

export interface ToolLoopRuntimeLLMResponse {
    content: string
    finishReason: string
    usage?: LLMClientResponse["usage"]
}

export interface ToolLoopRuntimeHooks<TStepInput = undefined> {
    onBeforeStep?(
        context: ToolLoopRuntimeStepContext<TStepInput>,
    ): Promise<void> | void
    onAfterStep?(
        context: ToolLoopRuntimeStepContext<TStepInput>,
        result: StepResult,
    ): Promise<void> | void
    onToken?(token: string): void | boolean
}

export interface ToolLoopAgentRuntimeDeps<TStepInput = undefined> {
    llmClient?: LLMClient
    loopCallbacks?: AgentLoopCallbacks
    hooks?: ToolLoopRuntimeHooks<TStepInput>
    requireTodoListOnFirstResponse?: boolean
}

export interface ToolLoopRuntimeSetup<
    TMemory extends AgentMemoryLayer,
    TEnforcer extends BaseValidationEnforcer,
> {
    memory: TMemory
    enforcer: TEnforcer
    conversation: ConversationAdapter
    loopDeps: Omit<AgentLoopDeps, "enforcer" | "conversation" | "callbacks">
}

export interface ToolLoopRuntimeInfrastructure<
    TMemory extends AgentMemoryLayer,
    TEnforcer extends BaseValidationEnforcer,
> extends ToolLoopRuntimeSetup<TMemory, TEnforcer> {
    loop: AgentLoop
}

export interface ToolLoopRuntimeRunStepResult<TStepInput = undefined> {
    context: ToolLoopRuntimeStepContext<TStepInput>
    response: ToolLoopRuntimeLLMResponse
    parsed: ParsedStepInput
    result: StepResult
}

export interface ToolLoopRuntimeExecuteStepResult {
    response: ToolLoopRuntimeLLMResponse
    parsed: ParsedStepInput
}

export abstract class ToolLoopAgentRuntime<
    TMemory extends AgentMemoryLayer = AgentMemoryLayer,
    TEnforcer extends BaseValidationEnforcer = BaseValidationEnforcer,
    TStepInput = undefined,
> {
    protected readonly llmClient: LLMClient | null
    protected readonly loopCallbacks: AgentLoopCallbacks
    protected readonly hooks: ToolLoopRuntimeHooks<TStepInput>
    private readonly requireTodoListOnFirstResponse: boolean

    private infrastructure: ToolLoopRuntimeInfrastructure<TMemory, TEnforcer> | null = null
    private infrastructurePromise: Promise<
        ToolLoopRuntimeInfrastructure<TMemory, TEnforcer>
    > | null = null

    protected constructor(deps: ToolLoopAgentRuntimeDeps<TStepInput>) {
        this.llmClient = deps.llmClient ?? null
        this.loopCallbacks = deps.loopCallbacks ?? {}
        this.hooks = deps.hooks ?? {}
        this.requireTodoListOnFirstResponse = deps.requireTodoListOnFirstResponse ?? false
    }

    protected abstract createRuntimeSetup(): Promise<
        ToolLoopRuntimeSetup<TMemory, TEnforcer>
    >

    protected abstract getToolDefinitions(): ToolDefinition[]

    protected buildSystemPrompt(
        _context: ToolLoopRuntimeStepContext<TStepInput>,
    ): string {
        throw new Error(
            `buildSystemPrompt is not implemented for ${this.constructor.name}`,
        )
    }

    protected buildLLMRequest(
        _context: ToolLoopRuntimeStepContext<TStepInput>,
        _messages: ChatMessage[],
    ): ToolLoopRuntimeLLMRequest {
        throw new Error(
            `buildLLMRequest is not implemented for ${this.constructor.name}`,
        )
    }

    protected parseStepResponse(
        _response: ToolLoopRuntimeLLMResponse,
        _tools: ToolDefinition[],
    ): ParsedStepInput {
        throw new Error(
            `parseStepResponse is not implemented for ${this.constructor.name}`,
        )
    }

    protected get runtimeLoop(): AgentLoop | null {
        return this.infrastructure?.loop ?? null
    }

    protected get runtimeMemory(): TMemory | null {
        return this.infrastructure?.memory ?? null
    }

    protected get runtimeEnforcer(): TEnforcer | null {
        return this.infrastructure?.enforcer ?? null
    }

    protected createStepContext(
        options: ToolLoopRuntimeRunStepOptions<TStepInput>,
        tools: ToolDefinition[],
    ): ToolLoopRuntimeStepContext<TStepInput> {
        return {
            task: options.task,
            actionCount: options.actionCount,
            tools,
            stepInput: options.stepInput,
        }
    }

    protected async ensureStaticContext(_memory: TMemory): Promise<void> {}

    protected async prepareMemoryForRun(
        memory: TMemory,
        task: string,
    ): Promise<void> {
        await this.ensureStaticContext(memory)
        memory.appendMessage("user", task)
    }

    protected async prepareMemoryForStep(memory: TMemory): Promise<void> {
        await this.ensureStaticContext(memory)
    }

    protected async buildStepMessages(
        memory: TMemory,
        context: ToolLoopRuntimeStepContext<TStepInput>,
    ): Promise<ChatMessage[]> {
        await this.prepareMemoryForStep(memory)
        const systemPrompt = this.buildSystemPrompt(context)
        return memory.buildMessages(systemPrompt)
    }

    protected async invokeLLM(
        request: ToolLoopRuntimeLLMRequest,
    ): Promise<ToolLoopRuntimeLLMResponse> {
        if (!this.llmClient) {
            throw new Error(
                `No llmClient is configured for ${this.constructor.name}. Override executeLLMStep() or provide llmClient in the constructor.`,
            )
        }

        const response = await this.llmClient.chat(
            {
                messages: request.messages,
                temperature: request.temperature,
                maxTokens: request.maxTokens,
                stream: Boolean(request.onToken ?? this.hooks.onToken),
                frequencyPenalty: request.frequencyPenalty,
                presencePenalty: request.presencePenalty,
            },
            request.onToken || this.hooks.onToken
                ? {
                      onToken: request.onToken ?? this.hooks.onToken,
                  }
                : undefined,
        )

        return {
            content: request.normalizeResponseContent
                ? request.normalizeResponseContent(response.content)
                : response.content,
            finishReason: response.finishReason,
            usage: response.usage,
        }
    }

    protected async executeLLMStep(
        context: ToolLoopRuntimeStepContext<TStepInput>,
        messages: ChatMessage[],
    ): Promise<ToolLoopRuntimeExecuteStepResult> {
        const response = await this.invokeLLM(
            this.buildLLMRequest(context, messages),
        )

        return {
            response,
            parsed: this.parseStepResponse(response, context.tools),
        }
    }

    protected async validateParsedStep(
        context: ToolLoopRuntimeStepContext<TStepInput>,
        parsed: ParsedStepInput,
    ): Promise<void> {
        if (
            this.requireTodoListOnFirstResponse
            && context.actionCount === 1
            && parsed.selectedToolCall?.name !== "manage_todo_list"
        ) {
            throw new Error(
                "VALIDATION_ERROR: You MUST call the manage_todo_list tool as your very first action to plan your work before executing any other tool. Break the task into specific, actionable steps.",
            )
        }
    }

    /**
     * Called after the LLM response is parsed but before the tool
     * executes.  Web runtimes override this to flush streaming content
     * to the store and transition the UI to a "tool running" state.
     */
    protected async onBeforeToolDispatch(
        _context: ToolLoopRuntimeStepContext<TStepInput>,
        _parsed: ParsedStepInput,
    ): Promise<void> {}

    protected async ensureInfrastructure(): Promise<
        ToolLoopRuntimeInfrastructure<TMemory, TEnforcer>
    > {
        if (this.infrastructurePromise) {
            return this.infrastructurePromise
        }

        const promise = (async () => {
            const setup = await this.createRuntimeSetup()
            const infrastructure = {
                ...setup,
                loop: new AgentLoop({
                    ...setup.loopDeps,
                    enforcer: setup.enforcer,
                    conversation: setup.conversation,
                    callbacks: this.loopCallbacks,
                }),
            }

            this.infrastructure = infrastructure
            return infrastructure
        })()

        this.infrastructurePromise = promise.catch((error) => {
            this.infrastructure = null
            this.infrastructurePromise = null
            throw error
        })

        return this.infrastructurePromise
    }

    async beginRun(
        task: string,
    ): Promise<ToolLoopRuntimeInfrastructure<TMemory, TEnforcer>> {
        const infrastructure = await this.ensureInfrastructure()
        await this.prepareMemoryForRun(infrastructure.memory, task)
        infrastructure.loop.start(task)
        return infrastructure
    }

    async runStep(
        options: ToolLoopRuntimeRunStepOptions<TStepInput>,
    ): Promise<ToolLoopRuntimeRunStepResult<TStepInput>> {
        const infrastructure = await this.ensureInfrastructure()
        const tools = this.getToolDefinitions()
        const context = this.createStepContext(options, tools)

        await infrastructure.loop.prepareStep(options.actionCount)
        await this.hooks.onBeforeStep?.(context)

        const messages = await this.buildStepMessages(
            infrastructure.memory,
            context,
        )
        const { response, parsed } = await this.executeLLMStep(
            context,
            messages,
        )
        await this.validateParsedStep(context, parsed)
        await this.onBeforeToolDispatch(context, parsed)
        const result = await infrastructure.loop.processStep(
            parsed,
            options.signal,
        )

        await this.hooks.onAfterStep?.(context, result)

        return {
            context,
            response,
            parsed,
            result,
        }
    }

    protected async onDestroy(
        _infrastructure: ToolLoopRuntimeInfrastructure<TMemory, TEnforcer>,
    ): Promise<void> {}

    async destroy(): Promise<void> {
        const infrastructurePromise = this.infrastructurePromise
        this.infrastructurePromise = null
        this.infrastructure = null

        if (!infrastructurePromise) {
            return
        }

        const infrastructure = await infrastructurePromise
        await this.onDestroy(infrastructure)
        infrastructure.loop.destroy()
        infrastructure.memory.dispose?.()
    }
}