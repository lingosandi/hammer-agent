/**
 * Shared ToolRegistry infrastructure.
 *
 * This mirrors the Hammer and Magic registry shape: a real
 * Map<string, Tool> registry with registration, lookup, execution,
 * definition generation, and executor creation.
 */

import type { ToolCall, ToolDefinition, ToolResult } from "./types"
import {
    DEFAULT_RUN_COMMAND_REGISTRY,
    executeToolCallWithRunCommands,
    type RunCommandRegistry,
    type RunInvocationTarget,
} from "./run-command-registry"

import { Tool, type ToolLike } from "./Tool"

type ToolExecutor = (toolCall: ToolCall) => Promise<ToolResult>
type BashExecutor = (command: string) => Promise<ToolResult>
type BackgroundBashExecutor = (command: string) => Promise<ToolResult>

export interface ToolRegistryMissingToolContext {
    name: string
    availableToolNames: string[]
}

export interface ToolRegistryBeforeExecuteContext {
    name: string
    parameters: Record<string, any>
    registry: ToolRegistry
}

export interface ToolRegistryOptions {
    tools?: Iterable<ToolLike>
    canExecute?: boolean | (() => boolean)
    executeBash?: BashExecutor
    executeBackgroundBash?: BackgroundBashExecutor
    runCommandRegistry?: RunCommandRegistry
    onMissingTool?: (
        context: ToolRegistryMissingToolContext,
    ) => Error | string
    beforeExecute?: (
        context: ToolRegistryBeforeExecuteContext,
    ) => Promise<ToolResult | void> | ToolResult | void
}

function isToolRegistryOptions(
    value: Iterable<ToolLike> | ToolRegistryOptions,
): value is ToolRegistryOptions {
    if (!value || typeof value !== "object") {
        return false
    }

    return (
        "tools" in value ||
        "canExecute" in value ||
        "executeBash" in value ||
        "executeBackgroundBash" in value ||
        "runCommandRegistry" in value ||
        "onMissingTool" in value ||
        "beforeExecute" in value
    )
}

export function createToolRegistry(
    tools: Iterable<ToolLike> = [],
    options: Omit<ToolRegistryOptions, "tools"> = {},
): ToolRegistry {
    return new ToolRegistry({
        ...options,
        tools,
    })
}

export class ToolRegistry {
    protected tools: Map<string, ToolLike>
    private canExecuteOverride?: boolean | (() => boolean)
    private bashExecutor?: BashExecutor
    private backgroundBashExecutor?: BackgroundBashExecutor
    private runCommandRegistry: RunCommandRegistry
    private onMissingTool?: ToolRegistryOptions["onMissingTool"]
    private beforeExecute?: ToolRegistryOptions["beforeExecute"]

    constructor(toolsOrOptions: Iterable<ToolLike> | ToolRegistryOptions = []) {
        this.tools = new Map()

        const options = isToolRegistryOptions(toolsOrOptions)
            ? toolsOrOptions
            : { tools: toolsOrOptions }

        this.canExecuteOverride = options.canExecute
        this.bashExecutor = options.executeBash
        this.backgroundBashExecutor = options.executeBackgroundBash
        this.runCommandRegistry = options.runCommandRegistry ?? DEFAULT_RUN_COMMAND_REGISTRY
        this.onMissingTool = options.onMissingTool
        this.beforeExecute = options.beforeExecute
        this.registerTools(options.tools ?? [])
    }

    registerTool(tool: ToolLike): void {
        this.tools.set(tool.getName(), tool)
    }

    registerTools(tools: Iterable<ToolLike>): void {
        for (const tool of tools) {
            this.registerTool(tool)
        }
    }

    replaceTools(tools: Iterable<ToolLike>): void {
        this.tools.clear()
        this.registerTools(tools)
    }

    hasTool(name: string): boolean {
        return this.tools.has(name)
    }

    getTool(name: string): ToolLike {
        const tool = this.tools.get(name)
        if (!tool) {
            throw this.buildMissingToolError(name)
        }
        return tool
    }

    protected buildMissingToolError(name: string): Error {
        const availableToolNames = Array.from(this.tools.keys()).sort((left, right) =>
            left.localeCompare(right),
        )

        if (this.onMissingTool) {
            const result = this.onMissingTool({
                name,
                availableToolNames,
            })
            return result instanceof Error ? result : new Error(result)
        }

        return new Error(
            `Tool not found: "${name}". Available tools: ${availableToolNames.join(", ")}`,
        )
    }

    getTools(): ToolLike[] {
        return Array.from(this.tools.values())
    }

    async executeTool(
        name: string,
        parameters: Record<string, any>,
    ): Promise<ToolResult> {
        return this.executeConcreteTool(name, parameters)
    }

    async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
        return executeToolCallWithRunCommands(
            this.createConcreteRuntime(),
            toolCall,
            this.runCommandRegistry,
        )
    }

    private createConcreteRuntime() {
        return {
            getToolDefinitions: () => this.getToolDefinitions(),
            executeTool: (name: string, parameters: Record<string, any>) =>
                this.executeConcreteTool(name, parameters),
            executeBash: this.bashExecutor,
            executeBackgroundBash: this.backgroundBashExecutor,
        }
    }

    private async executeConcreteTool(
        name: string,
        parameters: Record<string, any>,
    ): Promise<ToolResult> {
        if (this.beforeExecute) {
            const result = await this.beforeExecute({
                name,
                parameters,
                registry: this,
            })

            if (result !== undefined) {
                return result
            }
        }

        return this.getTool(name).execute(parameters)
    }

    getToolDefinitions(): ToolDefinition[] {
        return this.getTools().map((tool) => tool.toDefinition())
    }

    getToolNames(): string[] {
        return Array.from(this.tools.keys())
    }

    hasTools(): boolean {
        return this.tools.size > 0
    }

    canExecuteBash(): boolean {
        return typeof this.bashExecutor === "function"
    }

    canExecuteBackgroundBash(): boolean {
        return typeof this.backgroundBashExecutor === "function"
    }

    getAvailableRunTargets(): readonly RunInvocationTarget[] {
        return this.runCommandRegistry.getAllowedTargets(this.createConcreteRuntime())
    }

    getRunCommandRegistry(): RunCommandRegistry {
        return this.runCommandRegistry
    }

    canExecute(): boolean {
        if (typeof this.canExecuteOverride === "function") {
            return this.canExecuteOverride()
        }

        if (typeof this.canExecuteOverride === "boolean") {
            return this.canExecuteOverride
        }

        return this.hasTools() || this.canExecuteBash() || this.canExecuteBackgroundBash()
    }

    createExecutor(): ToolExecutor {
        return async (toolCall: ToolCall): Promise<ToolResult> => {
            try {
                return await this.executeToolCall(toolCall)
            } catch (err) {
                return {
                    success: false,
                    error: err instanceof Error ? err.message : String(err),
                }
            }
        }
    }
}
