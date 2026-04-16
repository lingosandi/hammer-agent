/**
 * SubAgentTool — a Tool that runs its own contained agentic loop.
 *
 * Subclasses define domain-specific logic in isolation so those rules
 * stay OUT of the main agent's context window:
 *
 *   - `getSubAgentSystemPrompt()` — the sub-agent's dedicated system prompt
 *   - `getSubAgentTools()`        — tools available within the sub-agent loop
 *   - `getSubAgentLLMProvider()`  — LLM provider config for sub-agent inference
 *
 * The main agent calls a SubAgentTool like any other tool, passing a `task`
 * string.  The sub-agent autonomously handles the task and returns the result.
 */

import { coerceToolCallToDefinition } from "./command-response-utils"
import { LLMClient } from "./llm-client"
import { parseAgentResponse } from "./agent-response-parser"
import { buildAgentSystemPrompt, buildCoreStaticRules } from "./prompt-helpers"
import { formatToolResultMessage } from "./tool-helpers"
import { Tool, type ToolLike, type ToolSchema } from "./Tool"
import type { LLMProviderConfig, ToolCall, ToolResult, ChatMessage } from "./types"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SubAgentToolOptions {
    /** Maximum tool-call rounds before giving up. Default: 10. */
    maxSteps?: number
    /** Temperature for LLM calls. Defaults to LLMClient's built-in default (0.2). */
    temperature?: number
    /**
     * Whether `execute()` awaits the sub-agent loop before returning.
     * - `true` (default): the parent agent blocks until the sub-agent finishes.
     * - `false`: the loop is fired in the background and `execute()` returns
     *   immediately. Override `onSubAgentDispatched()` to track the promise.
     */
    blocking?: boolean
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

/**
 * A Tool that runs its own contained agentic loop.
 *
 * Domain-specific rules live in `getSubAgentSystemPrompt()` and are never
 * injected into the main agent's context — only the short tool description
 * is visible to the parent.
 *
 * @example
 * ```ts
 * class ImagePromptAgent extends SubAgentTool {
 *   getName()  { return "GenerateImage" }
 *   getDescription() { return "Generate a slide background photo." }
 *   getSchema() { return { task: { type: "string", required: true, ... } } }
 *
 *   protected getSubAgentSystemPrompt() { return IMAGE_RULES_PROMPT }
 *   protected getSubAgentTools()        { return [new RawGenerateImage()] }
 *   protected getSubAgentLLMProvider()  { return getProviderConfig("qwen3.6-plus") }
 * }
 * ```
 */
export abstract class SubAgentTool extends Tool {
    protected readonly subAgentOptions: SubAgentToolOptions

    constructor(workspaceRoot: string = "", options?: SubAgentToolOptions) {
        super(workspaceRoot)
        this.subAgentOptions = options ?? {}
    }

    // ---- abstract surface ------------------------------------------------

    /** Domain-specific system prompt for this sub-agent's dedicated loop. */
    protected abstract getSubAgentSystemPrompt(): string

    /** Tools available within this sub-agent's loop. */
    protected abstract getSubAgentTools(): ToolLike[]

    /** LLM provider config used for this sub-agent's inference calls. */
    protected abstract getSubAgentLLMProvider(): LLMProviderConfig

    // ---- default task schema (override to add extra params) ---------------

    override getSchema(): ToolSchema {
        return {
            task: {
                type: "string" as const,
                required: true,
                positional: false,
                description: "The task for the sub-agent to complete.",
            },
        }
    }

    /**
     * Build the task string from raw execute params.
     * Override when `getSchema()` adds parameters beyond `task`.
     */
    protected buildSubAgentTask(params: Record<string, any>): string {
        return typeof params.task === "string" ? params.task.trim() : ""
    }

    // ---- non-blocking hook ------------------------------------------------

    /**
     * Called when `blocking` is `false`, right after the sub-agent loop is
     * dispatched in the background.  Override to track the promise (e.g. for
     * pending-generation registries) and return a custom immediate result.
     *
     * @param params  The raw parameters passed to `execute()`.
     * @param promise Settles when the background sub-agent loop completes.
     */
    protected onSubAgentDispatched(
        _params: Record<string, any>,
        _promise: Promise<void>,
    ): ToolResult {
        return { success: true, pending: true, message: "Sub-agent started in background." }
    }

    // ---- execute ---------------------------------------------------------

    override async execute(params: Record<string, any>): Promise<ToolResult> {
        const task = this.buildSubAgentTask(params)
        if (!task) return { success: false, error: "task is required" }

        if (this.subAgentOptions.blocking === false) {
            const promise = this.runSubAgentLoop(task).then(() => {}).catch(() => {})
            return this.onSubAgentDispatched(params, promise)
        }

        return this.runSubAgentLoop(task)
    }

    // ---- core loop -------------------------------------------------------

    protected async runSubAgentLoop(task: string): Promise<ToolResult> {
        const { maxSteps = 10, temperature } = this.subAgentOptions
        const llmClient = new LLMClient(this.getSubAgentLLMProvider())
        const subTools = this.getSubAgentTools()
        const toolMap = new Map(subTools.map(t => [t.getName(), t]))
        const toolDefs = subTools.map(t => t.toDefinition())

        const systemPrompt = buildAgentSystemPrompt({
            identityLine: this.getSubAgentSystemPrompt(),
            tools: toolDefs,
            allowedRunTargets: ["tool"],
            supplementalRules: buildCoreStaticRules(),
        })

        const messages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: task },
        ]

        for (let step = 0; step < maxSteps; step++) {
            const response = await llmClient.chat({ messages, temperature })
            messages.push({ role: "assistant", content: response.content })

            const parsed = parseAgentResponse(response.content, {
                // Allow "bash" so that exit 0 / exit 1 are intercepted as
                // success / failure signals without being executed.
                allowedRunTargets: ["tool", "bash"],
            })

            if (!parsed) {
                return { success: false, error: "Sub-agent produced no structured response" }
            }

            if (parsed.outcome === "success") {
                return { success: true, result: parsed.reasoning || "Done." }
            }

            if (parsed.outcome === "failure") {
                return { success: false, error: parsed.reasoning || "Sub-agent reported failure" }
            }

            if (parsed.selectedToolCall) {
                const raw = parsed.selectedToolCall as ToolCall
                // Coerce unix-style rawInvocation into proper typed parameters.
                const toolCall = coerceToolCallToDefinition(raw, toolDefs) ?? raw
                const tool = toolMap.get(toolCall.name)

                if (!tool) {
                    const errResult: ToolResult = {
                        success: false,
                        error: `Unknown tool: ${toolCall.name}. Available: ${[...toolMap.keys()].join(", ")}`,
                    }
                    messages.push({
                        role: "tool",
                        content: formatToolResultMessage(toolCall, errResult),
                    })
                    continue
                }

                const result = await tool.execute(toolCall.parameters)
                messages.push({
                    role: "tool",
                    content: formatToolResultMessage(toolCall, result),
                })
            }
        }

        return { success: false, error: `Sub-agent did not complete within ${maxSteps} steps` }
    }
}
