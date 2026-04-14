/**
 * AgentLoop — Shared agentic loop engine.
 *
 * Encapsulates the duplicated orchestration logic from both Magic
 * (use-agent.ts) and Hammer (UnifiedAgent.ts) into a single class:
 *
 *   - XState actor lifecycle (state machine transitions)
 *   - Step user-message injection
 *   - Post-LLM outcome handling (success / failure / continue)
 *   - Tool execution with truncation tracking
 *   - Validation / API error recovery via enforcer
 *
 * Consumers inject platform-specific behaviour through the
 * {@link AgentLoopDeps} interface:
 *   - Magic: streaming LLM, React state updates
 *   - Hammer: non-streaming LLM, disk persistence, CLI logging
 *
 * The caller is still responsible for:
 *   1. LLM calls + response parsing (fundamentally different per platform)
 *   2. UI updates (React setState / CLI logging)
 */

import { createActor, type Actor } from "xstate"
import {
    agentMachine,
    type AgentMachineState,
    type TruncatedToolInfo,
} from "./agent-machine"
import {
    buildStepUserMessage,
    shouldSkipStepUserMessage,
    extractTruncatedToolInfo,
} from "./prompt-helpers"
import {
    truncateToolResult,
    executeToolSafe,
    formatToolResultMessage,
} from "./tool-helpers"
import {
    buildNoStructuredResponseFoundError,
} from "./tool-call-recovery"
import type {
    BaseValidationEnforcer,
    EnforcerResult,
} from "./validation-enforcer"
import type {
    LoopOutcome,
    ToolCall,
    ToolResult,
} from "./types"

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/** Abstraction over conversation storage (memory layer / conversation manager). */
export interface ConversationAdapter {
    appendMessage(role: "user" | "assistant" | "tool", content: string): Promise<void>
    /** Append a tool result with tool name for compaction tracking. Falls back to appendMessage("tool",...) if not provided. */
    appendToolMessage?(content: string, toolCallId: string): Promise<void>
    getLastMessageRole(): string | undefined
    getLastMessageContent(): string | undefined
    triggerCompactionIfNeeded(): Promise<void>
}

/** Callbacks for platform-specific UI / logging. */
export interface AgentLoopCallbacks {
    onToolStart?(name: string, parameters: Record<string, unknown>, index: number, total: number): void
    onToolComplete?(name: string, result: ToolResult, truncatedResultStr: string): void
    onPhaseChange?(state: AgentMachineState): void
    /** Called when the agent reports success. */
    onComplete?(): void
    /** Called when the agent reports failure. */
    onFail?(): void
}

/** Everything the AgentLoop needs from its host environment. */
export interface AgentLoopDeps {
    /** Execute a single tool call. */
    executeTool: (call: ToolCall) => Promise<ToolResult>
    /** Validation / error enforcer. */
    enforcer: BaseValidationEnforcer
    /** Conversation storage adapter. */
    conversation: ConversationAdapter
    /** Optional: transform raw ToolResult before truncation (e.g. spinner cleanup). */
    formatToolResult?: (result: ToolResult, toolName: string) => ToolResult
    /**
     * Optional: pre-tool hook. Return non-null to **block** execution and
     * break out of the tool loop (e.g. Hammer's ListSkills-first enforcement).
     * The returned `lastToolResult` is stored and the machine transitions
     * to ENFORCEMENT_BREAK.
     */
    onBeforeToolExecution?: (
        name: string,
        params: Record<string, unknown>,
    ) => Promise<{ lastToolResult: string } | null>
    /** Platform-specific callbacks for UI/logging. */
    callbacks?: AgentLoopCallbacks
}



// ---------------------------------------------------------------------------
// Input / output types for processStep
// ---------------------------------------------------------------------------

/** Parsed LLM step response — the caller parses, AgentLoop processes. */
export interface ParsedStepInput {
    outcome: LoopOutcome
    reasoning?: string
    selectedToolCall?: ToolCall
    wasTruncated: boolean
    /**
     * Raw LLM content string. When provided, `processStep` records it
     * as an assistant message in the conversation adapter before
     * processing, so callers don't need to do it themselves.
     */
    rawContent?: string
}

/** Result of a single tool execution (for the caller to build UI). */
export interface ToolExecutionResult {
    name: string
    result: ToolResult
    truncatedResultStr: string
}

/** What processStep returns — outcome is the loop-control signal. */
export interface StepResult {
    outcome: LoopOutcome
    toolResults: ToolExecutionResult[]
}

// ---------------------------------------------------------------------------
// AgentLoop class
// ---------------------------------------------------------------------------

export class AgentLoop {
    private deps: AgentLoopDeps
    private actor: Actor<typeof agentMachine>
    private _truncatedToolInfo?: TruncatedToolInfo
    private _lastToolResult?: string

    constructor(deps: AgentLoopDeps) {
        this.deps = deps

        // Create and start the XState actor
        this.actor = createActor(agentMachine)
        this.actor.start()
    }

    // ── Internal helpers ─────────────────────────────────────────────

    /**
     * Send an event to the actor, silently swallowing errors if the actor
     * was stopped concurrently (e.g. abort/destroy during an async gap).
     */
    private safeSend(event: Parameters<typeof this.actor.send>[0]): void {
        try {
            this.actor.send(event)
        } catch {
            // Actor may already be stopped — ignore
        }
    }

    // ── Read-only state ──────────────────────────────────────────────

    /** Current XState machine state. */
    get machineState(): AgentMachineState {
        return this.actor.getSnapshot().value as AgentMachineState
    }

    /** Current action count from the machine context. */
    get actionCount(): number {
        return this.actor.getSnapshot().context.actionCount
    }

    /** Last truncation info (for the caller to store / display). */
    get truncatedToolInfo(): TruncatedToolInfo | undefined {
        return this._truncatedToolInfo
    }

    /** Last tool result string (independent of machine state). */
    get lastToolResult(): string | undefined {
        return this._lastToolResult
    }

    // ── Lifecycle ───────────────────────────────────────────────────

    /** Transition: idle → prompting. */
    start(task: string): void {
        this.safeSend({ type: "START", task })
        this.deps.callbacks?.onPhaseChange?.(this.machineState)
    }

    // ── Lifecycle: step preparation ──────────────────────────────────

    /**
     * Inject the step user-message and transition to analyzing.
     *
     * @param actionCountOverride If provided, use this count instead of the
     *   machine's internal count (useful when the caller tracks total count
     *   across sessions).
     * @returns `true` if a user message was injected, `false` if skipped.
     */
    async prepareStep(actionCountOverride?: number): Promise<boolean> {
        const lastRole = this.deps.conversation.getLastMessageRole()
        const lastContent = this.deps.conversation.getLastMessageContent()

        let injected = false
        if (!shouldSkipStepUserMessage(lastRole ?? null, lastContent ?? null)) {
            const msg = buildStepUserMessage({
                actionCount: actionCountOverride ?? (this.actionCount + 1),
                truncatedToolInfo: this._truncatedToolInfo,
            })
            // Clear truncation info after using it
            if (this._truncatedToolInfo) this._truncatedToolInfo = undefined
            await this.deps.conversation.appendMessage("user", msg)
            injected = true
        }

        // Machine: prompting → analyzing (increments actionCount)
        this.safeSend({ type: "PROMPT_COMPLETE" })
        this.deps.callbacks?.onPhaseChange?.(this.machineState)

        return injected
    }

    // ── Lifecycle: process a parsed step ─────────────────────────────

    /**
     * Process a fully-parsed LLM step response end-to-end.
     *
     * The caller is responsible for:
     *   1. The LLM call (streaming or not)
     *   2. Parsing the response into {@link ParsedStepInput}
     *   3. UI updates based on the returned {@link StepResult}
     *
    * This method handles:
    *   1. Recording the assistant message (when `rawContent` is provided)
    *   2. Terminal outcomes (success / failure)
    *   3. State machine transitions
    *   4. Tool execution (via deps.executeTool)
    *   5. Result formatting, truncation, and conversation storage
    *   6. Truncation tracking across iterations
     */
    async processStep(
        input: ParsedStepInput,
        signal?: AbortSignal,
    ): Promise<StepResult> {
        const {
            outcome,
            selectedToolCall,
            wasTruncated,
            rawContent,
        } = input
        let effectiveOutcome = outcome
        let effectiveSelectedToolCall = selectedToolCall
        // Circuit breaker removed: always allow the model to retry after failure

        // Record assistant message in conversation (when caller supplies raw content)
            if (rawContent && outcome !== "failure") {
            await this.deps.conversation.appendMessage("assistant", rawContent)
        }

        if (selectedToolCall) {
            effectiveOutcome = "continue"
            effectiveSelectedToolCall = selectedToolCall
        }

        // ── Terminal outcomes ─────────────────────────────────────────

        if (effectiveOutcome === "success") {
            this.safeSend({ type: "OUTCOME_SUCCESS" })
            this.deps.callbacks?.onComplete?.()
            this.deps.callbacks?.onPhaseChange?.(this.machineState)
            return {
                outcome: effectiveOutcome,
                toolResults: [],
            }
        }

        if (effectiveOutcome === "failure") {
            this.safeSend({
                type: "OUTCOME_FAILURE",
                error: input.reasoning || "Agent reported failure",
            })
            this.deps.callbacks?.onFail?.()
            this.deps.callbacks?.onPhaseChange?.(this.machineState)
            return {
                outcome: effectiveOutcome,
                toolResults: [],
            }
        }

        // ── Continue: execute tools ──────────────────────────────────

        this.safeSend({ type: "LLM_SUCCESS" })
        this.deps.callbacks?.onPhaseChange?.(this.machineState)

        const effectiveToolCalls = effectiveSelectedToolCall
            ? [effectiveSelectedToolCall]
            : []

        // Truncation tracking
        if (wasTruncated) {
            this._truncatedToolInfo = extractTruncatedToolInfo(effectiveToolCalls)
        }

        let enforcementBroke = false
        const toolResults: ToolExecutionResult[] = []

        if (effectiveToolCalls.length > 0) {
            for (let i = 0; i < effectiveToolCalls.length; i++) {
                if (signal?.aborted) break

                const tc = effectiveToolCalls[i]

                this.deps.callbacks?.onToolStart?.(tc.name, tc.parameters, i, effectiveToolCalls.length)

                // Pre-execution hook (e.g. Hammer's ListSkills-first enforcement)
                if (this.deps.onBeforeToolExecution) {
                    const blocked = await this.deps.onBeforeToolExecution(
                        tc.name,
                        tc.parameters,
                    )
                    if (blocked) {
                        this._lastToolResult = blocked.lastToolResult
                        this.safeSend({
                            type: "ENFORCEMENT_BREAK",
                            lastToolResult: blocked.lastToolResult,
                        })
                        enforcementBroke = true
                        break
                    }
                }

                // Execute
                const startedAt = Date.now()
                let result = await executeToolSafe(() =>
                    this.deps.executeTool(tc),
                )

                if (typeof result.duration_ms !== "number") {
                    result = {
                        ...result,
                        duration_ms: Date.now() - startedAt,
                    }
                }

                // Optional formatting (e.g. spinner cleanup)
                if (this.deps.formatToolResult) {
                    result = this.deps.formatToolResult(result, tc.name)
                }

                // Truncate
                let resultStr = formatToolResultMessage(tc, result)
                resultStr = truncateToolResult(resultStr, {
                    strategy: "head-tail",
                })

                // Update truncation info on first tool
                if (wasTruncated && this._truncatedToolInfo && i === 0) {
                    this._truncatedToolInfo.executionSucceeded =
                        result.success === true
                }

                // Store in conversation
                if (this.deps.conversation.appendToolMessage) {
                    await this.deps.conversation.appendToolMessage(
                        resultStr,
                        tc.name,
                    )
                } else {
                    await this.deps.conversation.appendMessage("tool", resultStr)
                }

                toolResults.push({
                    name: tc.name,
                    result,
                    truncatedResultStr: resultStr,
                })

                // Track last tool result (independent of machine state)
                this._lastToolResult = resultStr

                this.deps.callbacks?.onToolComplete?.(
                    tc.name,
                    result,
                    resultStr,
                )

                // No circuit breaker: always allow the model to retry after failure
            }

            if (!enforcementBroke) {
                // Trigger compaction (non-fatal)
                try {
                    await this.deps.conversation.triggerCompactionIfNeeded()
                } catch {
                    // non-fatal
                }

                // Machine: executing → updating
                this.safeSend({
                    type: "TOOLS_EXECUTED",
                    lastToolResult: toolResults.at(-1)?.truncatedResultStr,
                })
            }
        } else {
            const validationError = new Error(
                buildNoStructuredResponseFoundError(),
            )

            await this.handleLLMValidationError(validationError)
            this.safeSend({ type: "NO_TOOLS" })
        }

        // ── Finalize step ────────────────────────────────────────────

        if (this.machineState === "updating") {
            this.safeSend({ type: "UPDATE_COMPLETE" })
        }
        this.deps.callbacks?.onPhaseChange?.(this.machineState)

        return { outcome: effectiveOutcome, toolResults }
    }

    // ── Error handling ───────────────────────────────────────────────

    /** Handle an LLM validation error (JSON parse, Zod, etc.). */
    async handleLLMValidationError(
        error: Error,
    ): Promise<EnforcerResult> {
        const result = await this.deps.enforcer.handleValidationError(error)
        this.safeSend({
            type: "LLM_VALIDATION_ERROR",
            error: error.message,
        })
        this.deps.callbacks?.onPhaseChange?.(this.machineState)
        return result
    }

    /** Handle an LLM API error (network, rate limit, 5xx). */
    async handleLLMApiError(error: Error): Promise<EnforcerResult> {
        const result = await this.deps.enforcer.handleApiError(error)
        this.safeSend({ type: "LLM_API_ERROR", error: error.message })
        this.deps.callbacks?.onPhaseChange?.(this.machineState)
        return result
    }

    /**
     * Classify a step LLM error as validation or API error and
     * delegate to the appropriate handler.
     */
    async classifyStepError(error: Error): Promise<void> {
        if (error.message?.startsWith("VALIDATION_ERROR:")) {
            await this.handleLLMValidationError(error)
        } else {
            await this.handleLLMApiError(error)
        }
    }

    /**
     * Handle an unrecoverable error and transition the machine to a
     * terminal state.
     */
    async handleFatalError(errorMsg: string): Promise<void> {
        const result = await this.deps.enforcer.handleFatalError(errorMsg)
        this._lastToolResult = result.lastToolResult
        this.safeSend({ type: "OUTCOME_FAILURE", error: result.errorMessage })
        this.deps.callbacks?.onFail?.()
        this.deps.callbacks?.onPhaseChange?.(this.machineState)
    }

    // ── Machine context access ───────────────────────────────────────

    /** Send an arbitrary event to the machine (for platform-specific transitions). */
    sendEvent(event: Parameters<typeof this.actor.send>[0]): void {
        this.safeSend(event)
    }

    /** Get the raw machine context snapshot. */
    getContext() {
        return this.actor.getSnapshot().context
    }

    // ── Cleanup ──────────────────────────────────────────────────────

    /** Restore truncated tool info from a previous session. */
    restoreTruncatedToolInfo(info: TruncatedToolInfo | undefined): void {
        this._truncatedToolInfo = info
    }

    /** Stop the XState actor. Call during cleanup / unmount. */
    destroy(): void {
        this.actor.stop()
    }

    /**
     * Reset the AgentLoop by stopping the current actor and creating
     * a new one. Returns to idle state.
     */
    reset(): void {
        this.actor.stop()
        this.actor = createActor(agentMachine)
        this.actor.start()
        this._truncatedToolInfo = undefined
        this._lastToolResult = undefined
    }
}
