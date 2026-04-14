import type { ToolDefinition, ToolResult } from "./types"

import { Tool, type ToolMetadata } from "./Tool"

export type ProxyToolExecutor = (
    parameters: Record<string, any>,
    definition: ToolDefinition,
) => Promise<ToolResult>

/**
 * Shared adapter for exposing a ToolDefinition as a concrete Tool while
 * delegating execution across a runtime boundary.
 */
export class ProxyTool extends Tool {
    private definition: ToolDefinition
    private executor: ProxyToolExecutor

    constructor(
        definition: ToolDefinition,
        executor: ProxyToolExecutor,
    ) {
        super()
        this.definition = definition
        this.executor = executor
    }

    getName(): string {
        return this.definition.name
    }

    getDescription(): string {
        return this.definition.description
    }

    getSchema(): ToolDefinition["parameters"] {
        return this.definition.parameters
    }

    override getMetadata(): ToolMetadata {
        const baseMetadata = super.getMetadata()
        const metadata = this.definition.metadata

        return {
            category: metadata?.category ?? baseMetadata.category,
            capabilities: metadata?.capabilities ?? baseMetadata.capabilities,
            requirements: metadata?.requirements ?? baseMetadata.requirements,
            ...(metadata?.memory ? { memory: metadata.memory } : {}),
            ...(metadata?.source ? { source: metadata.source } : {}),
            ...(metadata?.mcpServerName
                ? { mcpServerName: metadata.mcpServerName }
                : {}),
        }
    }

    async execute(parameters: Record<string, any>): Promise<ToolResult> {
        return this.executor(parameters, this.definition)
    }
}