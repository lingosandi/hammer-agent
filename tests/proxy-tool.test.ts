import { describe, expect, test } from "vitest"
import { ProxyTool, type ProxyToolExecutor } from "../src/ProxyTool"
import type { ToolDefinition, ToolResult } from "../src/types"

function createTestDefinition(overrides?: Partial<ToolDefinition>): ToolDefinition {
    return {
        name: "TestTool",
        description: "A test tool",
        parameters: {
            path: { type: "string", description: "File path", required: true },
        },
        ...overrides,
    }
}

describe("ProxyTool", () => {
    test("getName returns definition name", () => {
        const tool = new ProxyTool(createTestDefinition(), async () => ({ success: true, data: null }))
        expect(tool.getName()).toBe("TestTool")
    })

    test("getDescription returns definition description", () => {
        const tool = new ProxyTool(createTestDefinition(), async () => ({ success: true, data: null }))
        expect(tool.getDescription()).toBe("A test tool")
    })

    test("getSchema returns definition parameters", () => {
        const definition = createTestDefinition()
        const tool = new ProxyTool(definition, async () => ({ success: true, data: null }))
        expect(tool.getSchema()).toEqual(definition.parameters)
    })

    test("execute delegates to executor", async () => {
        const expectedResult: ToolResult = { success: true, data: "file contents" }
        const executor: ProxyToolExecutor = async (params, def) => {
            expect(params).toEqual({ path: "README.md" })
            expect(def.name).toBe("TestTool")
            return expectedResult
        }

        const tool = new ProxyTool(createTestDefinition(), executor)
        const result = await tool.execute({ path: "README.md" })
        expect(result).toEqual(expectedResult)
    })

    test("execute returns error result from executor", async () => {
        const executor: ProxyToolExecutor = async () => ({
            success: false,
            error: "file not found",
        })

        const tool = new ProxyTool(createTestDefinition(), executor)
        const result = await tool.execute({ path: "missing.txt" })
        expect(result.success).toBe(false)
        expect(result.error).toBe("file not found")
    })

    test("getMetadata uses definition metadata when provided", () => {
        const tool = new ProxyTool(
            createTestDefinition({
                metadata: {
                    category: "filesystem",
                    capabilities: ["read"],
                    source: "builtin",
                },
            }),
            async () => ({ success: true, data: null }),
        )

        const metadata = tool.getMetadata()
        expect(metadata.category).toBe("filesystem")
        expect(metadata.capabilities).toEqual(["read"])
    })

    test("getMetadata falls back to base defaults", () => {
        const tool = new ProxyTool(createTestDefinition(), async () => ({ success: true, data: null }))
        const metadata = tool.getMetadata()
        expect(metadata.category).toBe("general")
        expect(metadata.capabilities).toEqual([])
        expect(metadata.requirements).toEqual([])
    })

    test("toDefinition roundtrips", () => {
        const definition = createTestDefinition()
        const tool = new ProxyTool(definition, async () => ({ success: true, data: null }))
        const output = tool.toDefinition()
        expect(output.name).toBe("TestTool")
        expect(output.description).toBe("A test tool")
        expect(output.parameters).toEqual(definition.parameters)
    })

    test("getUsageExample generates from schema", () => {
        const tool = new ProxyTool(createTestDefinition(), async () => ({ success: true, data: null }))
        const example = tool.getUsageExample()
        expect(example).toContain("TestTool")
    })
})
