import { describe, expect, test } from "vitest"

import {
    executeBackgroundUnixCommandString,
    executeUnixCommandString,
    formatToolCallAsUnixCommand,
    formatUnixToolSurface,
    parseUnixToolCommand,
} from "../src/unix-tooling"
import { executeToolCallWithRunCommands } from "../src/run-command-registry"
import type { ToolDefinition, ToolResult } from "../src/types"

const READ_TOOL_DEFINITION: ToolDefinition = {
    name: "Read",
    description: "Read a text file from the workspace.",
    parameters: {
        path: {
            type: "string",
            required: true,
            description: "Path to the file to read.",
        },
        start_line: {
            type: "number",
            description: "Optional starting line number.",
        },
        end_line: {
            type: "number",
            description: "Optional ending line number.",
        },
    },
}

const GLOB_TOOL_DEFINITION: ToolDefinition = {
    name: "Glob",
    description: "Find files by glob pattern.",
    parameters: {
        pattern: {
            type: "string",
            required: true,
            description: "Glob pattern to match.",
        },
    },
}

const GREP_TOOL_DEFINITION: ToolDefinition = {
    name: "Grep",
    description: "Search file contents with a pattern.",
    parameters: {
        pattern: {
            type: "string",
            required: true,
            description: "Pattern to search for.",
        },
    },
}

const CURL_TOOL_DEFINITION: ToolDefinition = {
    name: "Curl",
    description: "Execute curl-style HTTP arguments.",
    parameters: {
        args: {
            type: "string",
            required: true,
            description: "Raw curl-style arguments.",
        },
    },
    metadata: {
        category: "web",
        capabilities: ["fetch", "http", "raw_command_args"],
    },
}

const WEB_SEARCH_TOOL_DEFINITION: ToolDefinition = {
    name: "BraveWebSearch",
    description: "Search the web.",
    usageExample: 'BraveWebSearch --query "bitcoin price today"',
    parameters: {
        query: {
            type: "string",
            required: true,
            positional: false,
            description: "Search query.",
        },
    },
}

const READ_SKILL_TOOL_DEFINITION: ToolDefinition = {
    name: "ReadSkill",
    description: "Load a skill by name.",
    parameters: {
        skill_name: {
            type: "string",
            required: true,
            description: "Skill name.",
        },
    },
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
    READ_TOOL_DEFINITION,
    READ_SKILL_TOOL_DEFINITION,
    GLOB_TOOL_DEFINITION,
    GREP_TOOL_DEFINITION,
    CURL_TOOL_DEFINITION,
    WEB_SEARCH_TOOL_DEFINITION,
]

function createRuntime(options?: {
    executeTool?: (name: string, parameters: Record<string, any>) => Promise<ToolResult>
    executeBash?: (command: string) => Promise<ToolResult>
    executeBackgroundBash?: (command: string) => Promise<ToolResult>
}) {
    return {
        getToolDefinitions: () => TOOL_DEFINITIONS,
        executeTool:
            options?.executeTool ??
            (async (name, parameters) => ({
                success: true,
                output: JSON.stringify({ name, parameters }),
            })),
        ...(options?.executeBash ? { executeBash: options.executeBash } : {}),
        ...(options?.executeBackgroundBash
            ? { executeBackgroundBash: options.executeBackgroundBash }
            : {}),
    }
}

describe("unix-tooling", () => {
    test("formats the tool surface with direct tool syntax", () => {
        const result = formatUnixToolSurface(TOOL_DEFINITIONS)

        expect(result).toContain('## Registered Tools')
        expect(result).toContain('Invoke them with a standalone `---tool---` header followed by the tool payload on the next line.')
        expect(result).toContain("Read <path>")
        expect(result).toContain("Glob")
        expect(result).toContain("Grep")
        expect(result).toContain("Use the exact registered tool name and usage shown")
        expect(result).toContain("<param> is positional, otherwise use --flag value")
        expect(result).toContain("Never switch to bare assignment-style arguments")
        expect(result).toContain("For passthrough tools, pass raw arguments directly after the tool name")
        expect(result).toContain("Example: `Read README.md`")
        expect(result).toContain('Example: `BraveWebSearch --query "bitcoin price today"`')
        expect(result).toContain("BraveWebSearch --query <string>")
        expect(result).not.toContain("For passthrough tools like Curl")
        expect(result).not.toContain("wrapper flags like --args")
        expect(result).not.toContain("Run(command: string)")
        expect(result).not.toContain("aliases:")
    })

    test("parses quoted path arguments for direct tool invocations", () => {
        const parsed = parseUnixToolCommand(
            READ_TOOL_DEFINITION,
            'Read "docs/Read Me.md"',
        )

        expect(parsed).toEqual({
            ok: true,
            parameters: { path: "docs/Read Me.md" },
        })
    })

    test("preserves unknown backslash sequences inside quoted arguments", () => {
        const parsed = parseUnixToolCommand(
            READ_SKILL_TOOL_DEFINITION,
            'ReadSkill "front\\nend-design"',
        )

        expect(parsed).toEqual({
            ok: true,
            parameters: {
                skill_name: "front\\nend-design",
            },
        })
    })

    test("rejects named flags for required positional parameters and requires positional syntax", () => {
        const parsed = parseUnixToolCommand(
            READ_SKILL_TOOL_DEFINITION,
            'ReadSkill --skill-name frontend-design',
        )

        expect(parsed).toEqual({
            ok: false,
            error: "ReadSkill: --skill-name is not valid for required positional parameter skill_name. Provide that value positionally. Usage: ReadSkill <skill_name>",
        })
    })

    test("supports named flags for optional direct tool parameters", () => {
        const parsed = parseUnixToolCommand(
            READ_TOOL_DEFINITION,
            "Read package.json --start-line 5 --end-line 12",
        )

        expect(parsed).toEqual({
            ok: true,
            parameters: {
                path: "package.json",
                start_line: 5,
                end_line: 12,
            },
        })
    })

    test("supports boolean negation for direct tool commands", () => {
        const tool: ToolDefinition = {
            name: "Summarize",
            description: "Summarize a document.",
            parameters: {
                include_context: {
                    type: "boolean",
                    description: "Whether to include context.",
                },
            },
        }

        const parsed = parseUnixToolCommand(tool, "Summarize --no-include-context")

        expect(parsed).toEqual({
            ok: true,
            parameters: { include_context: false },
        })
    })

    test("uses named flags for optional custom tool parameters", () => {
        const tool: ToolDefinition = {
            name: "Search",
            description: "Search the web.",
            parameters: {
                query: {
                    type: "string",
                    description: "Search query",
                },
            },
        }

        const parsed = parseUnixToolCommand(tool, "Search --query weather")

        expect(parsed).toEqual({
            ok: true,
            parameters: { query: "weather" },
        })
    })

    test("supports required flags for tools that opt out of positional syntax", () => {
        const parsed = parseUnixToolCommand(
            WEB_SEARCH_TOOL_DEFINITION,
            'BraveWebSearch --query "bitcoin price today"',
        )

        expect(parsed).toEqual({
            ok: true,
            parameters: { query: "bitcoin price today" },
        })
    })

    test("rejects positional invocation when a required flag-style parameter is documented", () => {
        const parsed = parseUnixToolCommand(
            WEB_SEARCH_TOOL_DEFINITION,
            'BraveWebSearch bitcoin price today',
        )

        expect(parsed).toEqual({
            ok: false,
            error: "BraveWebSearch: unexpected positional arguments. Usage: BraveWebSearch --query <string>",
        })
    })

    test("rejects assignment-style required positional parameters with corrective guidance", () => {
        const parsed = parseUnixToolCommand(
            READ_SKILL_TOOL_DEFINITION,
            "ReadSkill skill_name=frontend-design",
        )

        expect(parsed).toEqual({
            ok: false,
            error: "ReadSkill: skill_name=frontend-design is not valid for required positional parameter skill_name. Provide that value positionally without skill_name=. Usage: ReadSkill <skill_name>",
        })
    })

    test("rejects assignment-style optional parameters and points callers to flags", () => {
        const parsed = parseUnixToolCommand(
            READ_TOOL_DEFINITION,
            "Read package.json start_line=5",
        )

        expect(parsed).toEqual({
            ok: false,
            error: "Read: start_line=5 is not valid for parameter start_line. Use --start-line <number>. Usage: Read <path> [--start-line <number>] [--end-line <number>]",
        })
    })

    test("rejects equals-style flag assignments and requires a space-separated value", () => {
        const parsed = parseUnixToolCommand(
            READ_TOOL_DEFINITION,
            "Read package.json --start-line=5 --end-line 12",
        )

        expect(parsed).toEqual({
            ok: false,
            error: "Read: --start-line=5 is not valid. Use --start-line <value> with a space-separated value. Usage: Read <path> [--start-line <number>] [--end-line <number>]",
        })
    })

    test("coerces bracketed arrays for custom tool commands", () => {
        const tool: ToolDefinition = {
            name: "SearchByTags",
            description: "Search by tags.",
            parameters: {
                tags: {
                    type: "array",
                    description: "Tags",
                    required: true,
                    items: { type: "string" },
                },
            },
        }

        const parsed = parseUnixToolCommand(
            tool,
            `SearchByTags '["dark-mode","mobile"]'`,
        )

        expect(parsed).toEqual({
            ok: true,
            parameters: { tags: ["dark-mode", "mobile"] },
        })
    })

    test("formats direct tool calls using exact tool names", () => {
        const command = formatToolCallAsUnixCommand(
            {
                name: "Read",
                parameters: {
                    path: "docs/Read Me.md",
                    start_line: 5,
                    end_line: 25,
                },
            },
            TOOL_DEFINITIONS,
        )

        expect(command).toBe('Read "docs/Read Me.md" --start-line 5 --end-line 25')
    })

    test("formats required flag-style parameters with their documented flag", () => {
        const command = formatToolCallAsUnixCommand(
            {
                name: "BraveWebSearch",
                parameters: {
                    query: "bitcoin price today",
                },
            },
            TOOL_DEFINITIONS,
        )

        expect(command).toBe('BraveWebSearch --query "bitcoin price today"')
    })

    test("preserves rawInvocation when formatting direct tool calls", () => {
        const command = formatToolCallAsUnixCommand(
            {
                kind: "tool",
                name: "Read",
                parameters: {},
                rawInvocation: 'Read "docs/Read Me.md"',
            },
            TOOL_DEFINITIONS,
        )

        expect(command).toBe('Read "docs/Read Me.md"')
    })

    test("parses passthrough direct tool commands without interpreting curl flags", () => {
        const parsed = parseUnixToolCommand(
            CURL_TOOL_DEFINITION,
            'Curl https://example.com -H "Accept: application/json" --data "{\\"hello\\":\\"world\\"}"',
        )

        expect(parsed).toEqual({
            ok: true,
            parameters: {
                args: 'https://example.com -H "Accept: application/json" --data "{\\"hello\\":\\"world\\"}"',
            },
        })
    })

    test("silently strips wrapper flag matching the passthrough parameter name", () => {
        const parsed = parseUnixToolCommand(
            CURL_TOOL_DEFINITION,
            'Curl --args "https://example.com"',
        )

        expect(parsed).toEqual({
            ok: true,
            parameters: {
                args: '"https://example.com"',
            },
        })
    })

    test("formats passthrough direct tool calls as raw command strings", () => {
        const command = formatToolCallAsUnixCommand(
            {
                name: "Curl",
                parameters: {
                    args: 'https://example.com -H "Accept: application/json"',
                },
            },
            TOOL_DEFINITIONS,
        )

        expect(command).toBe('Curl https://example.com -H "Accept: application/json"')
    })

    test("enriches direct tool-call results without losing payload fields", async () => {
        const result = await executeToolCallWithRunCommands(
            createRuntime({
                executeTool: async () => ({
                    success: true,
                    content: "demo",
                    path: "docs/Read Me.md",
                    extra: "kept",
                }),
            }),
            {
                name: "Read",
                kind: "tool",
                parameters: { path: "docs/Read Me.md" },
            },
        )

        expect(result.success).toBe(true)
        expect(result.content).toBe("demo")
        expect(result.extra).toBe("kept")
        expect(result.command).toBe('Read "docs/Read Me.md"')
        expect(result.command_name).toBe("Read")
        expect(result.route).toBe("Read")
    })

    test("fails direct execution when rawInvocation uses invalid assignment-style syntax", async () => {
        const calls: Record<string, unknown>[] = []

        const result = await executeToolCallWithRunCommands(
            createRuntime({
                executeTool: async (_name, parameters) => {
                    calls.push(parameters)

                    return {
                        success: true,
                        output: "ok",
                    }
                },
            }),
            {
                name: "ReadSkill",
                kind: "tool",
                parameters: {},
                rawInvocation: 'ReadSkill skill_name="frontend-design"',
            },
        )

        expect(result.success).toBe(false)
        expect(result.error).toBe("ReadSkill: skill_name=frontend-design is not valid for required positional parameter skill_name. Provide that value positionally without skill_name=. Usage: ReadSkill <skill_name>")
        expect(calls).toEqual([])
    })

    test("delegates bash execution when available", async () => {
        const calls: string[] = []
        const result = await executeUnixCommandString(
            'cat "docs/Read Me.md"',
            createRuntime({
                executeBash: async (command) => {
                    calls.push(command)
                    return {
                        success: true,
                        output: "ok",
                    }
                },
            }),
        )

        expect(calls).toEqual(['cat "docs/Read Me.md"'])
        expect(result.success).toBe(true)
        expect(result.command).toBe('cat "docs/Read Me.md"')
        expect(result.command_name).toBe("cat")
        expect(result.route).toBe("bash")
    })

    test("delegates background bash execution when available", async () => {
        const calls: string[] = []
        const result = await executeBackgroundUnixCommandString(
            'start hello --command "bun server.js" --port 3000',
            createRuntime({
                executeBackgroundBash: async (command) => {
                    calls.push(command)
                    return {
                        success: true,
                        started: true,
                    }
                },
            }),
        )

        expect(calls).toEqual(['start hello --command "bun server.js" --port 3000'])
        expect(result.success).toBe(true)
        expect(result.command).toBe('start hello --command "bun server.js" --port 3000')
        expect(result.route).toBe("background_bash")
    })

    test("returns a clear error when bash execution is unavailable", async () => {
        const result = await executeUnixCommandString("cat package.json", createRuntime())

        expect(result.success).toBe(false)
        expect(result.exit_code).toBe(1)
        expect(result.error).toContain("Bash execution is not available in this environment")
    })

    test("returns a clear error for empty bash commands", async () => {
        const result = await executeUnixCommandString(
            "   ",
            createRuntime({
                executeBash: async () => ({ success: true, output: "ok" }),
            }),
        )

        expect(result.success).toBe(false)
        expect(result.exit_code).toBe(1)
        expect(result.error).toContain("Bash command is required")
    })

    test("parses inline JSON array flag values with bracket-balanced tokenization", () => {
        const MANAGE_TODO: ToolDefinition = {
            name: "manage_todo_list",
            description: "Manage a todo list.",
            parameters: {
                todoList: {
                    type: "array",
                    required: true,
                    description: "Array of todo items.",
                },
            },
        }

        const result = parseUnixToolCommand(
            MANAGE_TODO,
            'manage_todo_list --todolist [{"id": 1, "title": "Plan architecture", "status": "in-progress"}, {"id": 2, "title": "Implement feature", "status": "not-started"}]',
        )

        expect(result.ok).toBe(true)
        if (result.ok) {
            const items = result.parameters.todoList as any[]
            expect(items).toHaveLength(2)
            expect(items[0].id).toBe(1)
            expect(items[0].title).toBe("Plan architecture")
            expect(items[0].status).toBe("in-progress")
            expect(items[1].id).toBe(2)
            expect(items[1].status).toBe("not-started")
        }
    })

    test("parses inline JSON array flag values containing unicode text", () => {
        const MANAGE_TODO: ToolDefinition = {
            name: "manage_todo_list",
            description: "Manage a todo list.",
            parameters: {
                todoList: {
                    type: "array",
                    required: true,
                    description: "Array of todo items.",
                },
            },
        }

        const result = parseUnixToolCommand(
            MANAGE_TODO,
            'manage_todo_list --todolist [{"id": 1, "title": "了解公司背景：核心定位、业务范围", "status": "in-progress"}, {"id": 2, "title": "梳理PPT整体架构", "status": "not-started"}]',
        )

        expect(result.ok).toBe(true)
        if (result.ok) {
            const items = result.parameters.todoList as any[]
            expect(items).toHaveLength(2)
            expect(items[0].title).toBe("了解公司背景：核心定位、业务范围")
            expect(items[1].title).toBe("梳理PPT整体架构")
        }
    })
})