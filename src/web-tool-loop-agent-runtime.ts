import {
    getCompactionProvider,
    getProviderConfig,
} from "./configure"

import type { AgentMachineState } from "./agent-machine"
import type { AgentLoopDeps, ParsedStepInput } from "./agent-loop"
import { createAgentMemoryLayer } from "./agent-memory-factory"
import type {
    AgentMemoryLayer,
    ToolMemoryExtractor,
} from "./agent-memory-layer"
import {
    coerceToolCallToDefinition,
    DEFAULT_ALLOWED_RUN_TARGETS,
} from "./command-response-utils"
import type { RunInvocationTarget } from "./command-response-utils"
import { LLMClient } from "./llm-client"
import {
    buildAgentSystemPrompt,
    buildCoreStaticRules,
} from "./prompt-helpers"
import type {
    RuntimeSnapshotUpdater,
    RuntimeStore,
} from "./runtime-store"
import {
    parseResponseWithRecovery,
    buildNoStructuredResponseFoundError,
} from "./tool-call-recovery"
import {
    ToolLoopAgentRuntime,
    type ToolLoopAgentRuntimeDeps,
    type ToolLoopRuntimeLLMRequest,
    type ToolLoopRuntimeLLMResponse,
    type ToolLoopRuntimeRunStepResult,
    type ToolLoopRuntimeSetup,
    type ToolLoopRuntimeStepContext,
} from "./tool-loop-agent-runtime"
import { StreamingToolParser } from "./streaming-tool-parser"
import type {
    ChatMessage,
    ToolDefinition,
    ToolResult,
} from "./types"
import {
    createConversationSink,
} from "./validation-enforcer"
import {
    applyIdleWebAgentState,
    applyInitialWebAgentRunState,
    createToolAgentMessage,
    createWebToolLoopCallbacks,
    PendingAgentMessageBuffer,
} from "./web-runtime-tooling"
import { WebValidationEnforcer } from "./web-validation-enforcer"
import type { TodoItem } from "./todo-types"
import {
    createWebAgentMessageIdGenerator,
    machineStateToWebAgentPhase,
    type AgentMessage,
    type AgentPhase,
} from "./web-agent-types"

export interface WebToolLoopRuntimeStateLike<
    TMessage extends AgentMessage = AgentMessage,
> {
    phase: AgentPhase
    messages: TMessage[]
    streamingContent: string
    actionCount: number
    error: string | null
    activeToolName: string | null
    todoItems: TodoItem[]
}

const STREAMING_CONTENT_TOKEN_BATCH_SIZE = 12

type WebToolLoopRuntimeError = Error & {
    isWebParseFailure?: boolean
    rawContent?: string
    alreadySurfacedFatalError?: boolean
}

export const suppressWebValidationLog = (
    _level: "warn" | "error",
    _message: string,
): void => {}

export function readDiagnosticLevel(
    content: string,
): AgentMessage["diagnosticLevel"] | undefined {
    const trimmedContent = content.trimStart()

    if (trimmedContent.startsWith("⚠️ ERROR:")) {
        return "error"
    }

    if (trimmedContent.startsWith("⚠️ WARNING:")) {
        return "warning"
    }

    return undefined
}

export function readDiagnosticSource(
    content: string,
): AgentMessage["diagnosticSource"] | undefined {
    const trimmedContent = content.trimStart()

    if (
        trimmedContent.startsWith("⚠️ ERROR:")
        || trimmedContent.startsWith("⚠️ WARNING:")
    ) {
        return "agent-feedback"
    }

    return undefined
}

export function mapConversationRoleToAgentRole(
    role: "user" | "assistant" | "system" | "tool",
): AgentMessage["role"] {
    if (role === "system") {
        return "assistant"
    }

    return role
}

export interface CreateWebRuntimeSetupOptions {
    memoryPreset: string
    getToolDefinitions: () => ToolDefinition[]
    executeTool: AgentLoopDeps["executeTool"]
    toolMemoryExtractor?: ToolMemoryExtractor
    validationLog?: (level: "warn" | "error", message: string) => void
}

export interface ExecuteWebLoopRunOptions<
    TState extends WebToolLoopRuntimeStateLike<TMessage>,
    TMessage extends AgentMessage,
    TStepInput extends { runId: number },
> {
    runId: number
    userTask: string
    stepInput: TStepInput
    createUserMessage: () => TMessage
    applyInitialState: (state: TState, userMessage: TMessage) => TState
    onStepCompleted: (
        step: ToolLoopRuntimeRunStepResult<TStepInput>,
    ) => Promise<void> | void
    createParseFailureMessage?: () => TMessage
    applyParseFailureState?: (state: TState, message: TMessage) => TState
    onBeforeRun?: () => void
    onAfterRun?: () => void
}

export interface WebToolLoopAgentRuntimeConstructorOptions<
    TState,
    TStepInput,
> extends ToolLoopAgentRuntimeDeps<TStepInput> {
    store: RuntimeStore<TState>
    messageIdPrefix: string
    getToolDefinitions: () => ToolDefinition[]
    memoryPreset: string
    executeTool: AgentLoopDeps["executeTool"]
    systemIdentity?: string
    extraRules: string
    temperature: number
    maxTokens: number
    toolMemoryExtractor?: ToolMemoryExtractor
    validationLog?: (level: "warn" | "error", message: string) => void
    allowedRunTargets?: readonly RunInvocationTarget[]
    logLabel?: string
    logFullSystemPromptOnChange?: boolean
    logFullLlmMessages?: boolean
}

export abstract class WebToolLoopAgentRuntime<
    TState extends WebToolLoopRuntimeStateLike<TMessage>,
    TMessage extends AgentMessage = AgentMessage,
    TStepInput extends { runId: number } = { runId: number },
> extends ToolLoopAgentRuntime<AgentMemoryLayer, WebValidationEnforcer, TStepInput> {
    protected readonly store: RuntimeStore<TState>
    protected readonly pendingToolMessages = new PendingAgentMessageBuffer<TMessage>()

    private readonly createMessageId: () => string
    private readonly runtimeToolDefinitions: () => ToolDefinition[]
    private readonly memoryPreset: string
    private readonly executeTool: AgentLoopDeps["executeTool"]
    private readonly systemIdentity?: string
    private readonly extraRules: string
    private readonly temperature: number
    private readonly maxTokens: number
    private readonly toolMemoryExtractor?: ToolMemoryExtractor
    private readonly validationLog?: (level: "warn" | "error", message: string) => void
    private readonly allowedRunTargets: readonly RunInvocationTarget[]
    private readonly logLabel: string
    private readonly logFullSystemPromptOnChange: boolean
    private readonly logFullLlmMessages: boolean
    private lastLoggedSystemPrompt: string | null = null
    protected abortController: AbortController | null = null
    protected memory: AgentMemoryLayer | null = null
    protected enforcer: WebValidationEnforcer | null = null
    protected running = false
    protected activeRunId: number | null = null
    protected nextRunId = 0
    protected inFlightRunPromise: Promise<void> | null = null
    private pendingDestroyPromise: Promise<void> | null = null
    private pendingSurfacedMessages: TMessage[] = []
    private pendingStreamingContent = new Map<number, string>()
    private pendingStreamingTokenCounts = new Map<number, number>()

    protected constructor(
        options: WebToolLoopAgentRuntimeConstructorOptions<TState, TStepInput>,
    ) {
        const {
            store,
            messageIdPrefix,
            getToolDefinitions,
            memoryPreset,
            executeTool,
            systemIdentity,
            extraRules,
            temperature,
            maxTokens,
            toolMemoryExtractor,
            validationLog,
            allowedRunTargets,
            logLabel,
            logFullSystemPromptOnChange,
            logFullLlmMessages,
            loopCallbacks: externalLoopCallbacks,
            ...deps
        } = options

        let syncPhaseHandler: (machineState?: AgentMachineState) => void = () => {}
        let activeToolNameUpdater: (activeToolName: string | null) => void = () => {}
        let toolCompleteHandler: (name: string, result: ToolResult, truncatedStr: string) => void = () => {}

        const resolvedLoopCallbacks = externalLoopCallbacks ?? createWebToolLoopCallbacks({
            getToolDefinitions,
            updateActiveToolName: (name) => activeToolNameUpdater(name),
            onToolCompleteMessage: (name, result, str) => toolCompleteHandler(name, result, str),
            onPhaseChange: (state) => syncPhaseHandler(state),
        })

        super({ ...deps, loopCallbacks: resolvedLoopCallbacks })

        this.store = store
        this.createMessageId = createWebAgentMessageIdGenerator(messageIdPrefix)
        this.runtimeToolDefinitions = getToolDefinitions
        this.memoryPreset = memoryPreset
        this.executeTool = executeTool
        this.systemIdentity = systemIdentity
        this.extraRules = extraRules
        this.temperature = temperature
        this.maxTokens = maxTokens
        this.toolMemoryExtractor = toolMemoryExtractor
        this.validationLog = validationLog
        this.allowedRunTargets = allowedRunTargets ?? DEFAULT_ALLOWED_RUN_TARGETS
        this.logLabel = logLabel ?? "WebToolLoopAgentRuntime"
        this.logFullSystemPromptOnChange = logFullSystemPromptOnChange ?? false
        this.logFullLlmMessages = logFullLlmMessages ?? false

        if (!externalLoopCallbacks) {
            syncPhaseHandler = (machineState) => this.syncPhase(machineState)
            activeToolNameUpdater = (activeToolName) => {
                this.updateSnapshotForActiveRun((current) => ({
                    ...current,
                    activeToolName,
                }))
            }
            toolCompleteHandler = (name, result, truncatedStr) => {
                this.pendingToolMessages.push(createToolAgentMessage({
                    id: this.nextMessageId(),
                    name,
                    content: truncatedStr,
                    success: result.success,
                }) as TMessage)
            }
        }
    }

    protected async createRuntimeSetup(): Promise<
        ToolLoopRuntimeSetup<AgentMemoryLayer, WebValidationEnforcer>
    > {
        return this.createWebRuntimeSetup({
            memoryPreset: this.memoryPreset,
            getToolDefinitions: this.runtimeToolDefinitions,
            executeTool: this.executeTool,
            toolMemoryExtractor: this.toolMemoryExtractor,
            validationLog: this.validationLog,
        })
    }

    protected override getToolDefinitions(): ToolDefinition[] {
        return this.runtimeToolDefinitions()
    }

    protected override async ensureStaticContext(memory: AgentMemoryLayer): Promise<void> {
        if (!memory.hasStaticContext()) {
            memory.setStaticContext(buildCoreStaticRules())
        }
    }

    protected getAllowedRunTargets(): readonly RunInvocationTarget[] {
        return this.allowedRunTargets
    }

    /**
     * Run targets for the parser layer. Always includes "bash" so the
     * universal finish signals (`---bash--- exit 0` / `exit 1`) are
     * recognized even when the agent has no bash execution capability.
     */
    private getParserRunTargets(): readonly RunInvocationTarget[] {
        const targets = this.getAllowedRunTargets()
        return targets.includes("bash") ? targets : [...targets, "bash" as RunInvocationTarget]
    }

    protected override buildSystemPrompt(
        context: ToolLoopRuntimeStepContext<TStepInput>,
    ): string {
        const allowedRunTargets = this.getAllowedRunTargets()

        return buildAgentSystemPrompt({
            tools: context.tools,
            identityLine: this.systemIdentity,
            supplementalRules: this.extraRules,
            bashAvailable: allowedRunTargets.includes("bash"),
            backgroundBashAvailable: allowedRunTargets.includes("background_bash"),
        })
    }

    protected override buildLLMRequest(
        context: { stepInput?: TStepInput },
        messages: ChatMessage[],
    ): ToolLoopRuntimeLLMRequest {
        return this.buildStreamingLLMRequest(context, messages, {
            temperature: this.temperature,
            maxTokens: this.maxTokens,
        })
    }

    protected override async invokeLLM(
        request: ToolLoopRuntimeLLMRequest,
    ): Promise<ToolLoopRuntimeLLMResponse> {
        if (this.logFullSystemPromptOnChange) {
            const fullSystemPrompt = request.messages.find(
                (message) => message.role === "system",
            )?.content

            if (fullSystemPrompt && fullSystemPrompt !== this.lastLoggedSystemPrompt) {
                this.lastLoggedSystemPrompt = fullSystemPrompt
                console.log(
                    `[${this.logLabel}] System prompt changed:\n${fullSystemPrompt}`,
                )
            }
        }

        if (this.logFullLlmMessages) {
            console.log(
                `[${this.logLabel}] Outbound LLM messages:\n${JSON.stringify(request.messages, null, 2)}`,
            )
        }

        return super.invokeLLM(request)
    }

    protected override parseStepResponse(
        response: { content: string; finishReason: string },
        tools: ToolDefinition[],
    ) {
        return this.parseRecoveringStepResponse(response, tools)
    }

    protected override async onBeforeToolDispatch(
        context: ToolLoopRuntimeStepContext<TStepInput>,
        parsed: ParsedStepInput,
    ): Promise<void> {
        const runId = context.stepInput?.runId
        if (runId === undefined || !this.isRunActive(runId)) {
            return
        }

        this.flushPendingStreamingContentForRun(runId)

        const toolName = parsed.selectedToolCall?.name ?? null
        if (toolName) {
            this.updateSnapshotForRun(runId, (state) => ({
                ...state,
                activeToolName: toolName,
            }))
        }
    }

    protected nextMessageId(): string {
        return this.createMessageId()
    }

    protected updateSnapshot(updater: RuntimeSnapshotUpdater<TState>): void {
        this.store.setSnapshot(updater)
    }

    protected isRunActive(runId: number): boolean {
        return this.activeRunId === runId
    }

    protected updateSnapshotForActiveRun(
        updater: RuntimeSnapshotUpdater<TState>,
    ): boolean {
        if (this.activeRunId === null) {
            return false
        }

        this.updateSnapshot(updater)
        return true
    }

    protected updateSnapshotForRun(
        runId: number,
        updater: RuntimeSnapshotUpdater<TState>,
    ): boolean {
        if (!this.isRunActive(runId)) {
            return false
        }

        this.updateSnapshot(updater)
        return true
    }

    protected async surfaceFatalError(
        error: unknown,
        runId: number,
    ): Promise<Error> {
        const fatalError = error instanceof Error ? error : new Error(String(error))
        const loop = this.runtimeLoop

        if (loop) {
            await loop.handleFatalError(fatalError.message)
            this.flushPendingSurfacedMessagesForRun(runId)
            this.syncPhase()
        }

        return fatalError
    }

    protected appendSurfacedConversationMessage(
        role: "user" | "assistant" | "system" | "tool",
        content: string,
    ): void {
        const messageRole = mapConversationRoleToAgentRole(role)
        const surfacedMessage = {
            id: this.nextMessageId(),
            role: messageRole,
            content,
            diagnosticLevel: readDiagnosticLevel(content),
            diagnosticSource: readDiagnosticSource(content),
            timestamp: Date.now(),
        } as TMessage

        if (this.activeRunId === null) {
            return
        }

        this.pendingSurfacedMessages.push(surfacedMessage)
    }

    protected takePendingSurfacedMessagesForRun(runId: number): TMessage[] {
        if (!this.isRunActive(runId) || this.pendingSurfacedMessages.length === 0) {
            return []
        }

        const pendingSurfacedMessages = this.pendingSurfacedMessages
        this.pendingSurfacedMessages = []
        return pendingSurfacedMessages
    }

    protected flushPendingSurfacedMessagesForRun(runId: number): void {
        const pendingSurfacedMessages = this.takePendingSurfacedMessagesForRun(runId)

        if (pendingSurfacedMessages.length === 0) {
            return
        }

        this.updateSnapshotForRun(runId, (state) => ({
            ...state,
            messages: [...state.messages, ...pendingSurfacedMessages],
        }))
    }

    protected clearPendingSurfacedMessages(): void {
        this.pendingSurfacedMessages = []
    }

    protected appendStreamingToken(runId: number, token: string): void {
        const nextContent = (this.pendingStreamingContent.get(runId) ?? "") + token
        const nextCount = (this.pendingStreamingTokenCounts.get(runId) ?? 0) + 1

        this.pendingStreamingContent.set(runId, nextContent)
        this.pendingStreamingTokenCounts.set(runId, nextCount)

        if (
            nextCount >= STREAMING_CONTENT_TOKEN_BATCH_SIZE
            || token.includes("\n")
        ) {
            this.flushPendingStreamingContentForRun(runId)
        }
    }

    protected flushPendingStreamingContentForRun(runId: number): void {
        const pendingContent = this.pendingStreamingContent.get(runId)
        if (!pendingContent) {
            return
        }

        this.pendingStreamingContent.delete(runId)
        this.pendingStreamingTokenCounts.delete(runId)

        this.updateSnapshotForRun(runId, (state) => ({
            ...state,
            streamingContent: state.streamingContent + pendingContent,
        }))
    }

    protected clearPendingStreamingContent(runId?: number): void {
        if (typeof runId === "number") {
            this.pendingStreamingContent.delete(runId)
            this.pendingStreamingTokenCounts.delete(runId)
            return
        }

        this.pendingStreamingContent.clear()
        this.pendingStreamingTokenCounts.clear()
    }

    protected syncPhase(machineState?: AgentMachineState): void {
        if (this.activeRunId === null) {
            return
        }

        const currentLoop = this.runtimeLoop
        if (!currentLoop) {
            return
        }

        const nextMachineState = machineState ?? currentLoop.machineState
        this.updateSnapshotForActiveRun((current) => ({
            ...current,
            phase: machineStateToWebAgentPhase(nextMachineState),
            actionCount: currentLoop.actionCount,
            error: currentLoop.getContext().error ?? null,
        }))
    }

    protected async createWebRuntimeSetup(
        options: CreateWebRuntimeSetupOptions,
    ): Promise<ToolLoopRuntimeSetup<AgentMemoryLayer, WebValidationEnforcer>> {
        if (!this.memory) {
            const compactionProviderName = getCompactionProvider()
            if (!compactionProviderName) {
                throw new Error(
                    "hammer-agent: compactionProvider is not configured. " +
                    "Call configure({ compactionProvider: 'yourProvider' }) before running the agent."
                )
            }
            const compactionClient = new LLMClient(
                getProviderConfig(compactionProviderName),
            )
            const { TiktokenEstimator } = await import("./tiktoken-estimator")
            const tokenEstimator = new TiktokenEstimator()

            this.memory = createAgentMemoryLayer(options.memoryPreset, {
                compactionClient,
                tokenEstimator,
                getToolDefinitions: options.getToolDefinitions,
                ...(options.toolMemoryExtractor
                    ? { toolMemoryExtractor: options.toolMemoryExtractor }
                    : {}),
            })
        }

        if (!this.enforcer) {
            const sink = createConversationSink((role, content) => {
                this.memory!.appendMessage(role, content)
                this.appendSurfacedConversationMessage(role, content)
            })

            this.enforcer = new WebValidationEnforcer(
                sink,
                options.validationLog
                    ? { onLog: options.validationLog }
                    : undefined,
            )
        }

        return {
            memory: this.memory,
            enforcer: this.enforcer,
            conversation: this.memory.toConversationAdapter(),
            loopDeps: {
                executeTool: options.executeTool,
            },
        }
    }



    protected buildStreamingLLMRequest(
        context: { stepInput?: TStepInput },
        messages: ChatMessage[],
        options: {
            temperature: number
            maxTokens: number
        },
    ): ToolLoopRuntimeLLMRequest {
        const runId = context.stepInput?.runId
        const runDetector = new StreamingToolParser({
            allowedRunTargets: this.getParserRunTargets(),
        })
        let reasoningStarted = false

        return {
            messages,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            normalizeResponseContent: () => runDetector.getFullContent(),
            onReasoningToken: (token: string) => {
                if (runId === undefined) return
                if (!reasoningStarted) {
                    reasoningStarted = true
                    this.appendStreamingToken(runId, "💭 thinking…\n")
                }
                this.appendStreamingToken(runId, token)
            },
            onToken: (token: string) => {
                runDetector.push(token)

                if (runId !== undefined) {
                    if (reasoningStarted) {
                        // Transition from reasoning to content — clear the
                        // thinking preview so only the real response shows.
                        reasoningStarted = false
                        this.clearPendingStreamingContent(runId)
                        this.updateSnapshotForRun(runId, (state) => ({
                            ...state,
                            streamingContent: "",
                        }))
                    }

                    if (runDetector.sealed) {
                        this.clearPendingStreamingContent(runId)
                        this.updateSnapshotForRun(runId, (state) => ({
                            ...state,
                            streamingContent: runDetector.getFullContent(),
                        }))
                    } else {
                        this.appendStreamingToken(runId, token)
                    }
                }

                if (runDetector.sealed) {
                    return true
                }

                return false
            },
        }
    }

    protected parseRecoveringStepResponse(
        response: { content: string; finishReason: string },
        tools: ToolDefinition[],
    ) {
        if (!response.content || response.content.length === 0) {
            throw new Error("Empty response from API")
        }

        let stepParsed
        try {
            stepParsed = parseResponseWithRecovery(response.content, {
                finishReason: response.finishReason,
                allowedRunTargets: this.getParserRunTargets(),
            })
        } catch (error: unknown) {
            const parseError = error instanceof Error
                ? error as WebToolLoopRuntimeError
                : new Error(String(error)) as WebToolLoopRuntimeError

            parseError.isWebParseFailure = true
            parseError.rawContent = response.content
            throw parseError
        }

        if (!stepParsed) {
            const parseError: WebToolLoopRuntimeError = new Error(
                buildNoStructuredResponseFoundError(),
            )
            parseError.isWebParseFailure = true
            parseError.rawContent = response.content
            throw parseError
        }

        return {
            outcome: stepParsed.outcome,
            reasoning: stepParsed.reasoning,
            selectedToolCall: coerceToolCallToDefinition(
                stepParsed.selectedToolCall,
                tools,
            ),
            wasTruncated: response.finishReason === "length",
            rawContent: response.content,
        }
    }

    protected async startSerializedRun(
        execute: (runId: number) => Promise<void>,
    ): Promise<void> {
        if (this.running) {
            return
        }

        const previousRunPromise = this.inFlightRunPromise
        if (previousRunPromise) {
            await previousRunPromise
        }

        const runId = ++this.nextRunId
        this.activeRunId = runId

        const runPromise = execute(runId)
        this.inFlightRunPromise = runPromise

        try {
            await runPromise
        } finally {
            if (this.inFlightRunPromise === runPromise) {
                this.inFlightRunPromise = null
            }
        }
    }

    protected async executeWebLoopRun(
        options: ExecuteWebLoopRunOptions<TState, TMessage, TStepInput>,
    ): Promise<void> {
        const {
            runId,
            userTask,
            stepInput,
            createUserMessage,
            applyInitialState,
            onStepCompleted,
            createParseFailureMessage,
            applyParseFailureState,
            onBeforeRun,
            onAfterRun,
        } = options

        let finalPhase: AgentPhase | null = null
        let finalError: string | null = null

        this.running = true
        this.clearPendingSurfacedMessages()
        this.pendingToolMessages.clear()
        onBeforeRun?.()

        const ac = new AbortController()
        this.abortController = ac

        const userMessage = createUserMessage()

        this.updateSnapshotForRun(runId, (state) =>
            applyInitialState(state, userMessage))

        try {
            await this.beginRun(userTask)
            this.syncPhase()

            while (!ac.signal.aborted) {
                const currentLoop = this.runtimeLoop
                if (!currentLoop) {
                    return
                }

                this.updateSnapshotForRun(runId, (state) => ({
                    ...state,
                    streamingContent: "",
                    activeToolName: null,
                }))
                this.clearPendingStreamingContent(runId)

                try {
                    const step = await this.runStep({
                        task: userTask,
                        actionCount: currentLoop.actionCount + 1,
                        signal: ac.signal,
                        stepInput,
                    })

                    if (ac.signal.aborted) {
                        return
                    }

                    await onStepCompleted(step)
                    this.flushPendingSurfacedMessagesForRun(runId)
                    this.syncPhase()

                    if (step.result.outcome === "success") {
                        finalPhase = "complete"
                        finalError = currentLoop.getContext().error ?? null
                        this.updateSnapshotForRun(runId, (state) => ({
                            ...state,
                            phase: "complete",
                            actionCount: currentLoop.actionCount,
                            error: currentLoop.getContext().error ?? null,
                        }))
                    }

                    if (step.result.outcome === "failure") {
                        finalPhase = "error"
                        finalError =
                            currentLoop.getContext().error
                            ?? "Agent reported failure"
                        this.updateSnapshotForRun(runId, (state) => ({
                            ...state,
                            phase: "error",
                            actionCount: currentLoop.actionCount,
                            error:
                                currentLoop.getContext().error
                                ?? state.error
                                ?? "Agent reported failure",
                        }))
                    }

                    if (step.result.outcome !== "continue") {
                        break
                    }
                } catch (stepError: unknown) {
                    if (ac.signal.aborted) {
                        return
                    }

                    const loop = this.runtimeLoop
                    const error = stepError instanceof Error
                        ? stepError as WebToolLoopRuntimeError
                        : new Error(String(stepError)) as WebToolLoopRuntimeError

                    if (!loop) {
                        throw error
                    }

                    if (error.alreadySurfacedFatalError) {
                        this.flushPendingStreamingContentForRun(runId)
                        this.flushPendingSurfacedMessagesForRun(runId)
                        this.updateSnapshotForRun(runId, (state) => ({
                            ...state,
                            phase: "error",
                            error: error.message,
                            streamingContent: "",
                            activeToolName: null,
                        }))
                        finalPhase = "error"
                        finalError = error.message
                        break
                    }

                    if (error.isWebParseFailure) {
                        this.clearPendingStreamingContent(runId)
                        this.updateSnapshotForRun(runId, (state) => ({
                            ...state,
                            streamingContent: "",
                            activeToolName: null,
                        }))
                    }

                    await loop.classifyStepError(error)

                    if (
                        error.isWebParseFailure
                        && createParseFailureMessage
                        && applyParseFailureState
                    ) {
                        const parseFailureMessage = createParseFailureMessage()

                        this.updateSnapshotForRun(runId, (state) =>
                            applyParseFailureState(state, parseFailureMessage))
                    }

                    this.flushPendingStreamingContentForRun(runId)
                    this.flushPendingSurfacedMessagesForRun(runId)
                    this.syncPhase()

                    continue
                }
            }
        } catch (error: unknown) {
            if (!ac.signal.aborted) {
                this.flushPendingStreamingContentForRun(runId)
                const fatalError = await this.surfaceFatalError(error, runId)
                const errorMessage = fatalError.message
                finalPhase = "error"
                finalError = errorMessage

                this.updateSnapshotForRun(runId, (state) => ({
                    ...state,
                    phase: "error",
                    error: errorMessage,
                }))
            }
        } finally {
            this.clearPendingStreamingContent(runId)
            if (this.activeRunId === runId) {
                this.activeRunId = null
            }

            if (this.abortController === ac) {
                this.running = false
                this.abortController = null
                this.pendingToolMessages.clear()
                onAfterRun?.()

                if (!ac.signal.aborted && finalPhase) {
                    this.updateSnapshot((state) => ({
                        ...state,
                        phase: finalPhase,
                        error: finalError,
                    }))
                }
            }

            this.runtimeLoop?.reset()
        }
    }

    protected abortWebRuntime(
        applyAbortState: (state: TState) => TState,
        cleanup?: () => void,
    ): void {
        this.abortController?.abort()
        this.running = false
        this.activeRunId = null
        this.clearPendingSurfacedMessages()
        this.clearPendingStreamingContent()
        this.pendingToolMessages.clear()
        cleanup?.()

        const loop = this.runtimeLoop
        if (loop) {
            try {
                loop.sendEvent({ type: "OUTCOME_FAILURE", error: "Aborted by user" })
            } catch {
                // The machine may already be in a final state.
            }
        }

        this.updateSnapshot((state) => applyAbortState(state))
    }

    private scheduleRuntimeDestroy(): void {
        if (this.pendingDestroyPromise) {
            this.inFlightRunPromise = this.pendingDestroyPromise
            return
        }

        const basePromise = this.inFlightRunPromise ?? Promise.resolve()
        const destroyPromise = basePromise
            .finally(() => super.destroy())
            .finally(() => {
                if (this.pendingDestroyPromise === destroyPromise) {
                    this.pendingDestroyPromise = null
                }

                if (this.inFlightRunPromise === destroyPromise) {
                    this.inFlightRunPromise = null
                }
            })

        this.pendingDestroyPromise = destroyPromise
        this.inFlightRunPromise = destroyPromise
    }

    protected resetWebRuntime(cleanup?: () => void): void {
        this.memory = null
        this.enforcer = null
        this.clearPendingSurfacedMessages()
        this.clearPendingStreamingContent()
        this.pendingToolMessages.clear()
        cleanup?.()

        this.scheduleRuntimeDestroy()

        this.store.resetSnapshot()
    }

    protected async clearWebRuntimeState(cleanup?: () => void): Promise<void> {
        this.memory = null
        this.enforcer = null
        this.activeRunId = null
        this.clearPendingSurfacedMessages()
        this.clearPendingStreamingContent()
        this.pendingToolMessages.clear()
        cleanup?.()
    }

    protected defaultWebAbort(): void {
        this.abortWebRuntime((state) => applyIdleWebAgentState(state))
    }

    protected defaultWebReset(): void {
        this.defaultWebAbort()
        this.resetWebRuntime()
    }

    protected override async onDestroy(): Promise<void> {
        await this.clearWebRuntimeState()
    }

    protected async executeDefaultWebRun(
        userTask: string,
        options?: {
            shouldSurfaceAssistantContent?: (reasoning?: string, rawContent?: string) => boolean
            onNonContinueStep?: () => Promise<void>
            onBeforeRun?: () => void
            onAfterRun?: () => void
        },
    ): Promise<void> {
        await this.startSerializedRun((runId) =>
            this.executeWebLoopRun({
                runId,
                userTask,
                stepInput: { runId } as TStepInput,
                onBeforeRun: options?.onBeforeRun,
                createUserMessage: () => ({
                    id: this.nextMessageId(),
                    role: "user" as const,
                    content: userTask,
                    timestamp: Date.now(),
                }) as TMessage,
                applyInitialState: (state, userMessage) =>
                    applyInitialWebAgentRunState(state, userMessage),
                onStepCompleted: async (step) => {
                    const assistantContent = step.parsed.reasoning?.trim()
                    const rawAssistantContent = step.parsed.rawContent?.trim()
                    const pendingSurfacedMessages = this.takePendingSurfacedMessagesForRun(runId)
                    const pendingToolMessages = this.pendingToolMessages.takeForRun(
                        runId,
                        (activeRunId) => this.isRunActive(activeRunId),
                    )

                    const shouldSurface = step.result.outcome !== "failure"
                        && (options?.shouldSurfaceAssistantContent
                            ? options.shouldSurfaceAssistantContent(assistantContent, rawAssistantContent)
                            : Boolean(rawAssistantContent || assistantContent))

                    const newMessages: TMessage[] = []

                    if (shouldSurface) {
                        newMessages.push({
                            id: this.nextMessageId(),
                            role: "assistant" as const,
                            content: assistantContent || rawAssistantContent || "",
                            reasoning: assistantContent,
                            rawContent: rawAssistantContent,
                            timestamp: Date.now(),
                        } as TMessage)
                    }

                    newMessages.push(...pendingSurfacedMessages, ...pendingToolMessages)

                    this.updateSnapshotForRun(runId, (state) => ({
                        ...state,
                        ...(newMessages.length > 0
                            ? { messages: [...state.messages, ...newMessages] }
                            : {}),
                        streamingContent: "",
                        activeToolName: null,
                    }))

                    if (step.result.outcome !== "continue" && options?.onNonContinueStep) {
                        await options.onNonContinueStep()
                    }
                },
                onAfterRun: options?.onAfterRun,
            }))
    }
}