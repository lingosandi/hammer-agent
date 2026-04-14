/**
 * Base Tool class — all shared tools extend this.
 *
 * Mirrors the Hammer agent tool format so code is shared between
 * apps/hammer and apps/tauri via the DRY principle.
 *
 * Filesystem-aware tools should extend SystemTool directly, which adds
 * `validatePath()` on top of this base class.
 */

import type {
    ToolDefinition,
    ToolDefinitionMetadata,
    ToolResult,
} from "./types"
import { buildToolUsageExample } from "./tool-usage-examples"

// ---------------------------------------------------------------------------
// Types (re-exported so consumers don't need a second import)
// ---------------------------------------------------------------------------

/** Tool parameter schema — same shape as ToolDefinition["parameters"]. */
export type ToolSchema = ToolDefinition["parameters"]

/** Tool metadata — generic version (Hammer extends this with constrained categories). */
export interface ToolMetadata extends ToolDefinitionMetadata {
    requirements: string[]
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

/**
 * Structural interface for any tool that can be registered in a ToolRegistry.
 * Using an interface lets both this class hierarchy and external class
 * hierarchies (e.g. @shared/tools) be stored in the same registry without
 * requiring a shared base-class inheritance chain.
 */
export interface ToolLike {
    execute(params: Record<string, any>): Promise<ToolResult>
    getName(): string
    getDescription(): string
    getSchema(): ToolSchema
    getUsageExample(): string | undefined
    getMetadata(): ToolMetadata
    toDefinition(): ToolDefinition
}

export abstract class Tool implements ToolLike {
    protected workspaceRoot: string

    constructor(workspaceRoot: string = "") {
        this.workspaceRoot = workspaceRoot
    }

    /**
     * Get tool metadata — capabilities, categories, requirements.
     * Override in subclasses.
     */
    getMetadata(): ToolMetadata {
        return {
            category: "general",
            capabilities: [],
            requirements: [],
        }
    }

    /** Execute the tool — must be implemented by subclasses. */
    abstract execute(params: Record<string, any>): Promise<ToolResult>

    /** Get tool name. */
    abstract getName(): string

    /** Get tool description. */
    abstract getDescription(): string

    /** Get parameter schema. */
    abstract getSchema(): ToolSchema

    /** Get an explicit usage example shown in tool prompts. */
    getUsageExample(): string | undefined {
        return buildToolUsageExample({
            name: this.getName(),
            parameters: this.getSchema(),
            metadata: this.getMetadata(),
        })
    }

    /** Convert this tool instance to a ToolDefinition for LLM consumption. */
    toDefinition(): ToolDefinition {
        return {
            name: this.getName(),
            description: this.getDescription(),
            usageExample: this.getUsageExample(),
            parameters: this.getSchema(),
            metadata: this.getMetadata(),
        }
    }
}
