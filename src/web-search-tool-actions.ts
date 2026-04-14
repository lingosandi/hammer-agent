import type { ToolResult } from "./types"

export type WebSearchToolActionInput = {
    tool: "BraveWebSearch" | "BochaWebSearch"
    input: Record<string, unknown>
}

type WebSearchToolActionDeps = {
    executeWebSearch: (tool: "BraveWebSearch" | "BochaWebSearch", input: Record<string, unknown>) => Promise<ToolResult>
}

export function createWebSearchToolActions(deps: WebSearchToolActionDeps) {
    return {
        executeWebTool: async (input: WebSearchToolActionInput): Promise<ToolResult> => {
            return deps.executeWebSearch(input.tool, input.input)
        },
    }
}