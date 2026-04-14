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
            if (input.tool !== "BraveWebSearch" && input.tool !== "BochaWebSearch") {
                throw new Error(`Unknown tool: ${String(input.tool)}`)
            }

            return deps.executeWebSearch(input.tool, input.input)
        },
    }
}