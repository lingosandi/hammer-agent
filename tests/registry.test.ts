import { describe, expect, test } from "vitest"
import { ToolRegistry, createToolRegistry } from "../src/registry"
import { ProxyTool } from "../src/ProxyTool"
import type { ToolDefinition, ToolResult } from "../src/types"

function createMockTool(name: string, result?: ToolResult) {
    return new ProxyTool(
        {
            name,
            description: `Mock ${name}`,
            parameters: {
                input: { type: "string", description: "Input", required: true },
            },
        },
        async () => result ?? { success: true, data: `${name} result` },
    )
}

describe("ToolRegistry", () => {
    test("registers and retrieves a tool", () => {
        const registry = new ToolRegistry()
        const tool = createMockTool("ReadFile")
        registry.registerTool(tool)

        expect(registry.hasTool("ReadFile")).toBe(true)
        expect(registry.getTool("ReadFile")).toBe(tool)
    })

    test("throws on missing tool", () => {
        const registry = new ToolRegistry()
        expect(() => registry.getTool("Missing")).toThrow('Tool not found: "Missing"')
    })

    test("custom onMissingTool error message", () => {
        const registry = new ToolRegistry({
            onMissingTool: ({ name }) => `No such tool: ${name}`,
        })
        expect(() => registry.getTool("Foo")).toThrow("No such tool: Foo")
    })

    test("custom onMissingTool returns Error object", () => {
        const registry = new ToolRegistry({
            onMissingTool: ({ name }) => new Error(`Custom: ${name}`),
        })
        expect(() => registry.getTool("Bar")).toThrow("Custom: Bar")
    })

    test("registerTools registers multiple tools", () => {
        const registry = new ToolRegistry()
        registry.registerTools([createMockTool("A"), createMockTool("B")])

        expect(registry.hasTool("A")).toBe(true)
        expect(registry.hasTool("B")).toBe(true)
    })

    test("replaceTools clears and re-registers", () => {
        const registry = new ToolRegistry()
        registry.registerTool(createMockTool("Old"))
        registry.replaceTools([createMockTool("New")])

        expect(registry.hasTool("Old")).toBe(false)
        expect(registry.hasTool("New")).toBe(true)
    })

    test("getTools returns all registered tools", () => {
        const registry = new ToolRegistry([createMockTool("A"), createMockTool("B")])
        expect(registry.getTools()).toHaveLength(2)
    })

    test("getToolNames returns sorted-by-insertion names", () => {
        const registry = new ToolRegistry([createMockTool("B"), createMockTool("A")])
        expect(registry.getToolNames()).toEqual(["B", "A"])
    })

    test("getToolDefinitions returns definitions for all tools", () => {
        const registry = new ToolRegistry([createMockTool("X")])
        const definitions = registry.getToolDefinitions()
        expect(definitions).toHaveLength(1)
        expect(definitions[0].name).toBe("X")
    })

    test("hasTools returns false for empty registry", () => {
        expect(new ToolRegistry().hasTools()).toBe(false)
    })

    test("hasTools returns true when tools exist", () => {
        expect(new ToolRegistry([createMockTool("A")]).hasTools()).toBe(true)
    })

    test("executeTool delegates to the tool", async () => {
        const registry = new ToolRegistry([
            createMockTool("Echo", { success: true, data: "echoed" }),
        ])
        const result = await registry.executeTool("Echo", { input: "test" })
        expect(result).toEqual({ success: true, data: "echoed" })
    })

    test("canExecuteBash returns false by default", () => {
        expect(new ToolRegistry().canExecuteBash()).toBe(false)
    })

    test("canExecuteBash returns true when executor provided", () => {
        const registry = new ToolRegistry({
            executeBash: async () => ({ success: true, data: null }),
        })
        expect(registry.canExecuteBash()).toBe(true)
    })

    test("canExecuteBackgroundBash returns false by default", () => {
        expect(new ToolRegistry().canExecuteBackgroundBash()).toBe(false)
    })

    test("canExecuteBackgroundBash returns true when executor provided", () => {
        const registry = new ToolRegistry({
            executeBackgroundBash: async () => ({ success: true, data: null }),
        })
        expect(registry.canExecuteBackgroundBash()).toBe(true)
    })

    test("canExecute returns false for empty registry without executors", () => {
        expect(new ToolRegistry().canExecute()).toBe(false)
    })

    test("canExecute returns true when tools exist", () => {
        expect(new ToolRegistry([createMockTool("A")]).canExecute()).toBe(true)
    })

    test("canExecute returns true when bash executor exists", () => {
        const registry = new ToolRegistry({
            executeBash: async () => ({ success: true, data: null }),
        })
        expect(registry.canExecute()).toBe(true)
    })

    test("canExecute respects boolean override", () => {
        const registry = new ToolRegistry({
            tools: [createMockTool("A")],
            canExecute: false,
        })
        expect(registry.canExecute()).toBe(false)
    })

    test("canExecute respects function override", () => {
        let allowed = false
        const registry = new ToolRegistry({
            tools: [createMockTool("A")],
            canExecute: () => allowed,
        })
        expect(registry.canExecute()).toBe(false)
        allowed = true
        expect(registry.canExecute()).toBe(true)
    })

    test("beforeExecute can intercept execution", async () => {
        const registry = new ToolRegistry({
            tools: [createMockTool("Blocked")],
            beforeExecute: async () => ({ success: false, error: "intercepted" }),
        })
        const result = await registry.executeTool("Blocked", {})
        expect(result).toEqual({ success: false, error: "intercepted" })
    })

    test("beforeExecute returning undefined passes through", async () => {
        const registry = new ToolRegistry({
            tools: [createMockTool("Passthrough", { success: true, data: "ok" })],
            beforeExecute: async () => undefined,
        })
        const result = await registry.executeTool("Passthrough", {})
        expect(result).toEqual({ success: true, data: "ok" })
    })

    test("createExecutor wraps executeToolCall", async () => {
        const registry = new ToolRegistry({
            tools: [createMockTool("Run", { success: true, data: "ran" })],
            executeBash: async (cmd) => ({ success: true, data: cmd }),
        })
        const executor = registry.createExecutor()

        const result = await executor({ kind: "bash", name: "Bash", parameters: { command: "echo hi" } })
        expect(result.success).toBe(true)
    })

    test("createExecutor catches errors and returns error result", async () => {
        const registry = new ToolRegistry()
        const executor = registry.createExecutor()

        const result = await executor({ kind: "tool", name: "Missing", parameters: {} })
        expect(result.success).toBe(false)
        expect(result.error).toContain("Missing")
    })
})

describe("createToolRegistry", () => {
    test("creates registry with tools", () => {
        const registry = createToolRegistry([createMockTool("A")])
        expect(registry.hasTool("A")).toBe(true)
    })

    test("creates empty registry by default", () => {
        const registry = createToolRegistry()
        expect(registry.hasTools()).toBe(false)
    })

    test("passes options through", () => {
        const registry = createToolRegistry([], { canExecute: true })
        expect(registry.canExecute()).toBe(true)
    })
})
