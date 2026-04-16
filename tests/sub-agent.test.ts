import { describe, expect, test, vi } from "vitest"

import { SubAgentTool } from "../src/sub-agent"
import { Tool } from "../src/Tool"
import type { ToolResult, LLMProviderConfig } from "../src/types"
import type { ToolLike, ToolSchema } from "../src/Tool"

// ---------------------------------------------------------------------------
// Test inner tool — echoes back the received prompt
// ---------------------------------------------------------------------------

class EchoTool extends Tool {
    getName() { return "Echo" }
    getDescription() { return "Echoes back the input." }
    getSchema(): ToolSchema {
        return {
            message: { type: "string", required: true, positional: false, description: "Message to echo." },
        }
    }
    async execute(params: Record<string, any>): Promise<ToolResult> {
        return { success: true, output: `echo: ${params.message}` }
    }
}

// ---------------------------------------------------------------------------
// Concrete SubAgentTool for testing
// ---------------------------------------------------------------------------

class TestSubAgent extends SubAgentTool {
    getName() { return "TestAgent" }
    getDescription() { return "A test sub-agent." }

    protected getSubAgentSystemPrompt() {
        return "You are a test agent. Call Echo with the user's message then exit 0."
    }
    protected getSubAgentTools(): ToolLike[] {
        return [new EchoTool()]
    }
    protected getSubAgentLLMProvider(): LLMProviderConfig {
        return { apiKey: "test", baseUrl: "http://localhost", model: "test" }
    }
}

describe("SubAgentTool", () => {
    test("toDefinition() produces correct definition", () => {
        const agent = new TestSubAgent()
        const def = agent.toDefinition()
        expect(def.name).toBe("TestAgent")
        expect(def.description).toBe("A test sub-agent.")
        expect(def.parameters).toHaveProperty("task")
        expect(def.parameters.task.required).toBe(true)
    })

    test("execute returns error when task is empty", async () => {
        const agent = new TestSubAgent()
        const result = await agent.execute({ task: "" })
        expect(result.success).toBe(false)
        expect(result.error).toBe("task is required")
    })

    test("execute returns error when task is missing", async () => {
        const agent = new TestSubAgent()
        const result = await agent.execute({})
        expect(result.success).toBe(false)
        expect(result.error).toBe("task is required")
    })

    test("default schema has task parameter", () => {
        const agent = new TestSubAgent()
        const schema = agent.getSchema()
        expect(schema.task).toBeDefined()
        expect(schema.task.type).toBe("string")
        expect(schema.task.required).toBe(true)
    })
})
