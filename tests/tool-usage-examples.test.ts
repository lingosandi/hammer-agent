import { describe, expect, test } from "vitest"
import { buildToolUsageExample } from "../src/tool-usage-examples"

describe("buildToolUsageExample", () => {
    test("generates positional arguments for required string params", () => {
        const result = buildToolUsageExample({
            name: "ReadFile",
            parameters: {
                path: { type: "string", description: "File path", required: true },
            },
        })
        expect(result).toBe("ReadFile README.md")
    })

    test("generates flag-style arguments for non-positional required params", () => {
        const result = buildToolUsageExample({
            name: "Search",
            parameters: {
                query: { type: "string", description: "Search query", required: true },
                limit: { type: "number", description: "Max results", required: true, positional: false },
            },
        })
        expect(result).toContain("Search")
        expect(result).toContain("--limit 1")
    })

    test("generates boolean flags without values", () => {
        const result = buildToolUsageExample({
            name: "List",
            parameters: {
                path: { type: "string", description: "Dir", required: true },
                recursive: { type: "boolean", description: "Recurse", required: true },
            },
        })
        expect(result).toContain("--recursive")
        expect(result).not.toContain("--recursive true")
    })

    test("uses enum first value as sample", () => {
        const result = buildToolUsageExample({
            name: "SetMode",
            parameters: {
                mode: { type: "string", description: "Mode", required: true, enum: ["dark", "light"] },
            },
        })
        expect(result).toBe("SetMode dark")
    })

    test("generates passthrough form for raw_command_args tools", () => {
        const result = buildToolUsageExample({
            name: "Bash",
            parameters: {
                command: { type: "string", description: "Shell command", required: true },
            },
            metadata: { capabilities: ["raw_command_args"] },
        })
        expect(result).toContain("Bash")
        expect(result).toContain("cat README.md")
    })

    test("converts underscores to hyphens in flag names", () => {
        const result = buildToolUsageExample({
            name: "Tool",
            parameters: {
                input_path: { type: "string", description: "Input", required: true, positional: false },
            },
        })
        expect(result).toContain("--input-path")
    })

    test("handles tool with no parameters", () => {
        const result = buildToolUsageExample({
            name: "Status",
            parameters: {},
        })
        expect(result).toBe("Status")
    })

    test("handles number type with sample value 1", () => {
        const result = buildToolUsageExample({
            name: "Resize",
            parameters: {
                width: { type: "number", description: "Width", required: true },
            },
        })
        expect(result).toBe("Resize 1")
    })

    test("handles query parameter with contextual sample", () => {
        const result = buildToolUsageExample({
            name: "WebSearch",
            parameters: {
                query: { type: "string", description: "Search query", required: true },
            },
            metadata: { capabilities: ["raw_command_args"] },
        })
        expect(result).toContain("bitcoin price today")
    })
})
