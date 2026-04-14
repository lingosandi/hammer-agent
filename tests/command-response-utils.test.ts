import { describe, expect, test } from "vitest"

import {
    coerceToolCallToDefinition,
    extractRunInvocations,
    parseStructuredAgentText,
} from "../src/command-response-utils"
import type { ToolDefinition } from "../src/types"

const bashSegment = (payload: string) => ["---bash---", payload].join("\n")
const toolSegment = (payload: string) => ["---tool---", payload].join("\n")
const backgroundBashSegment = (payload: string) => ["---background_bash---", payload].join("\n")
const exitSuccessSegment = () => bashSegment("exit 0")

describe("command-response-utils - schema-aware tool parameter coercion", () => {
    test("coerces array parameters using tool definitions", () => {
        const toolDefinition: ToolDefinition = {
            name: "get_style_guide",
            description: "Fetch a style guide",
            parameters: {
                tags: {
                    type: "array",
                    description: "Style guide tags",
                    items: { type: "string" },
                    required: true,
                },
            },
        }

        const selectedToolCall = coerceToolCallToDefinition(
            {
                name: "get_style_guide",
                parameters: { tags: '["dark-mode","mobile"]' },
            },
            [toolDefinition],
        )

        expect(selectedToolCall?.parameters.tags).toEqual(["dark-mode", "mobile"])
    })

    test("coerces object parameters using tool definitions", () => {
        const toolDefinition: ToolDefinition = {
            name: "set_variables",
            description: "Set design variables",
            parameters: {
                variables: {
                    type: "object",
                    description: "Variable definitions",
                    required: true,
                },
            },
        }

        const selectedToolCall = coerceToolCallToDefinition(
            {
                name: "set_variables",
                parameters: {
                    variables:
                        '{"color.primary":{"type":"color","value":"#ffffff"}}',
                },
            },
            [toolDefinition],
        )

        expect(selectedToolCall?.parameters.variables).toEqual({
            "color.primary": {
                type: "color",
                value: "#ffffff",
            },
        })
    })

    test("does not coerce structured-looking strings when the schema expects a string", () => {
        const toolDefinition: ToolDefinition = {
            name: "WriteFile",
            description: "Write a file",
            parameters: {
                content: {
                    type: "string",
                    description: "File contents",
                    required: true,
                },
            },
        }

        const selectedToolCall = coerceToolCallToDefinition(
            {
                name: "WriteFile",
                parameters: { content: '{"still":"string content"}' },
            },
            [toolDefinition],
        )

        expect(selectedToolCall?.parameters.content).toBe('{"still":"string content"}')
    })

    test("coerces comma-separated array fallbacks using the declared item type", () => {
        const toolDefinition: ToolDefinition = {
            name: "set_spacing_scale",
            description: "Set a spacing scale",
            parameters: {
                values: {
                    type: "array",
                    description: "Spacing values",
                    items: { type: "number" },
                    required: true,
                },
            },
        }

        const selectedToolCall = coerceToolCallToDefinition(
            {
                name: "set_spacing_scale",
                parameters: { values: "8, 16, 24" },
            },
            [toolDefinition],
        )

        expect(selectedToolCall?.parameters.values).toEqual([8, 16, 24])
    })

    test("parses standalone bash segments", () => {
        const parsed = parseStructuredAgentText(
            bashSegment("find . -type f -not -path './.git/*' 2>/dev/null | sort"),
        )

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: "find . -type f -not -path './.git/*' 2>/dev/null | sort",
            },
        })
    })

    test("parses same-line payloads when the slug header starts its own control line", () => {
        const parsed = parseStructuredAgentText([
            "Task complete.",
            "---bash--- exit 0",
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.outcome).toBe("success")
        expect(parsed?.selectedToolCall).toBeUndefined()
        expect(parsed?.prose).toBe("Task complete.")
    })

    test("parses inline trailing finish segments for compatibility", () => {
        const parsed = parseStructuredAgentText("Task complete. ---bash--- exit 0")

        expect(parsed).not.toBeNull()
        expect(parsed?.outcome).toBe("success")
        expect(parsed?.selectedToolCall).toBeUndefined()
        expect(parsed?.prose).toBe("Task complete.")
    })

    test("parses multiline bash heredoc segments with inner html quotes", () => {
        const parsed = parseStructuredAgentText([
            "I need to create the landing page.",
            bashSegment([
                "cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'",
                "",
                '<html lang="en">',
                "<head>",
                '  <meta charset="UTF-8">',
                "  <title>LUMINA</title>",
                "</head>",
                "<body>",
                '  <div class="logo">LUMINA</div>',
                "</body>",
                "</html>",
                "HTMLEOF",
            ].join("\n")),
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'",
                    "",
                    '<html lang="en">',
                    "<head>",
                    '  <meta charset="UTF-8">',
                    "  <title>LUMINA</title>",
                    "</head>",
                    "<body>",
                    '  <div class="logo">LUMINA</div>',
                    "</body>",
                    "</html>",
                    "HTMLEOF",
                ].join("\n"),
            },
        })
    })

    test("rejects header mentions when they appear inline in prose", () => {
        const parsed = parseStructuredAgentText(
            'The docs show ---tool--- inline in prose, which should not execute.',
        )

        expect(parsed).toBeNull()
    })

    test("parses raw bash invocations with nested quotes and parentheses", () => {
        const parsed = parseStructuredAgentText(
            bashSegment('python -c "print(\'(ok)\')"'),
        )

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: 'python -c "print(\'(ok)\')"',
            },
        })
        expect(parsed?.selectedToolCallCount).toBe(1)
    })

    test("parses raw multiline bash invocations", () => {
        const parsed = parseStructuredAgentText([
            "I need to run a short script.",
            bashSegment([
                "python - <<'PY'",
                "print('ok')",
                "PY",
            ].join("\n")),
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: "python - <<'PY'\nprint('ok')\nPY",
            },
        })
        expect(parsed?.selectedToolCallCount).toBe(1)
    })

    test("parses multiline heredoc bash invocations that include a pasted shell prompt marker", () => {
        const parsed = parseStructuredAgentText([
            "I need to create the landing page.",
            bashSegment([
                "$ cat > apps/monaco-glass/index.html << 'HTMLEOF'",
                "<!DOCTYPE html>",
                "<style>",
                "  :root {",
                "    --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);",
                "  }",
                "</style>",
                "HTMLEOF",
            ].join("\n")),
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > apps/monaco-glass/index.html << 'HTMLEOF'",
                    "<!DOCTYPE html>",
                    "<style>",
                    "  :root {",
                    "    --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);",
                    "  }",
                    "</style>",
                    "HTMLEOF",
                ].join("\n"),
            },
        })
        expect(parsed?.selectedToolCallCount).toBe(1)
    })

    test("drops natural-language fallout after a heredoc terminator when transcript markers follow", () => {
        const parsed = parseStructuredAgentText([
            "I need to write the file.",
            bashSegment([
                "$ cat > index.html << 'EOF'",
                "<!DOCTYPE html>",
                "<html lang=\"en\">",
                "<body>Hello</body>",
                "</html>",
                "EOF",
                "",
                "I'll verify the file was created correctly.",
                "[stderr]",
                "bash: line 10: unexpected EOF while looking for matching `''",
                "[meta] tool=\"bash\" route=\"bash\"",
                "[exit:2 | 8ms]",
                "[SYSTEM_EXEC:14:42:31]",
                "The heredoc had an issue.",
            ].join("\n")),
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > index.html << 'EOF'",
                    "<!DOCTYPE html>",
                    "<html lang=\"en\">",
                    "<body>Hello</body>",
                    "</html>",
                    "EOF",
                ].join("\n"),
            },
        })
        expect(parsed?.selectedToolCallCount).toBe(1)
    })

    test("repairs missing heredoc terminators before transcript artifacts for TSX content", () => {
        const parsed = parseStructuredAgentText([
            "I need to create the app shell.",
            bashSegment([
                "$ cat > src/App.tsx << 'EOF'",
                "import { Box } from '@mui/material'",
                "",
                "export default function App() {",
                "  return (",
                "    <Box",
                "      sx={{",
                "        '& .MuiLinearProgress-bar': {",
                "          bgcolor: `${color}.main`,",
                "        },",
                "      }}",
                "    />",
                "  )",
                "}",
                "[stderr]",
                "bash: syntax error: Parse error at 491:4: unexpected EOF while looking for matching ``'",
                "[meta] tool=\"cat\" route=\"bash\"",
                "[exit:2 | 14ms]",
            ].join("\n")),
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > src/App.tsx << 'EOF'",
                    "import { Box } from '@mui/material'",
                    "",
                    "export default function App() {",
                    "  return (",
                    "    <Box",
                    "      sx={{",
                    "        '& .MuiLinearProgress-bar': {",
                    "          bgcolor: `${color}.main`,",
                    "        },",
                    "      }}",
                    "    />",
                    "  )",
                    "}",
                    "EOF",
                ].join("\n"),
            },
        })
        expect(parsed?.selectedToolCallCount).toBe(1)
    })

    test("collapses duplicate heredoc terminators before transcript artifacts", () => {
        const parsed = parseStructuredAgentText([
            "I need to create the app shell.",
            bashSegment([
                "$ cat > src/App.tsx << 'EOF'",
                "export default function App() {",
                "  return <div>Hello</div>",
                "}",
                "EOF",
                "EOF",
                "[stderr]",
                "bash: EOF: command not found",
                "[meta] tool=\"cat\" route=\"bash\"",
                "[exit:127 | 14ms]",
            ].join("\n")),
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > src/App.tsx << 'EOF'",
                    "export default function App() {",
                    "  return <div>Hello</div>",
                    "}",
                    "EOF",
                ].join("\n"),
            },
        })
        expect(parsed?.selectedToolCallCount).toBe(1)
    })

    test("parses background bash invocations when explicitly allowed", () => {
        const parsed = parseStructuredAgentText(
            backgroundBashSegment('start hello --command "bun server.js" --port 3000'),
            { allowedTargets: ["tool", "bash", "background_bash"] },
        )

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "background_bash",
            name: "BackgroundBash",
            parameters: {
                command: 'start hello --command "bun server.js" --port 3000',
            },
            rawInvocation: 'start hello --command "bun server.js" --port 3000',
        })
        expect(parsed?.selectedToolCallCount).toBe(1)
    })

    test("coerces raw string arguments that contain parentheses via rawInvocation", () => {
        const toolDefinition: ToolDefinition = {
            name: "test",
            description: "Test parser behavior.",
            parameters: {
                input: {
                    type: "string",
                    description: "Input text",
                    required: true,
                },
            },
        }

        const parsed = parseStructuredAgentText(
            toolSegment("test 'this is a test()'"),
        )

        expect(parsed).not.toBeNull()
        expect(parsed?.selectedToolCall).toEqual({
            kind: "tool",
            name: "test",
            parameters: {},
            rawInvocation: "test 'this is a test()'",
        })

        const selectedToolCall = coerceToolCallToDefinition(
            parsed?.selectedToolCall,
            [toolDefinition],
        )

        expect(selectedToolCall?.parameters.input).toBe("this is a test()")
    })

    test("coerces truncated quoted arguments when the recovered invocation is marked truncated", () => {
        const toolDefinition: ToolDefinition = {
            name: "Read",
            description: "Read a file.",
            parameters: {
                path: {
                    type: "string",
                    description: "File path",
                    required: true,
                },
            },
        }

        const selectedToolCall = coerceToolCallToDefinition(
            {
                kind: "tool",
                name: "Read",
                parameters: {},
                rawInvocation: 'Read "docs/Read Me.md',
                truncated: true,
            },
            [toolDefinition],
        )

        expect(selectedToolCall?.parameters.path).toBe("docs/Read Me.md")
    })

    test("extractRunInvocations keeps only standalone header blocks", () => {
        const parsed = extractRunInvocations([
            "The instructions say ---tool--- in prose, which should not execute.",
            exitSuccessSegment(),
        ].join("\n"))

        expect(parsed).toHaveLength(1)
        expect(parsed[0]).toMatchObject({
            target: "bash",
            command: "exit 0",
            raw: exitSuccessSegment(),
            truncated: false,
        })
    })

    test("parseStructuredAgentText ignores inline header mentions and records the final directive", () => {
        const parsed = parseStructuredAgentText([
            "The instructions say I should use the ---tool--- header at the end.",
            exitSuccessSegment(),
        ].join("\n"))

        expect(parsed).not.toBeNull()
        expect(parsed?.outcome).toBe("success")
        expect(parsed?.selectedToolCall).toBeUndefined()
        expect(parsed?.selectedToolCallCount).toBe(0)
    })

    test("parseStructuredAgentText rejects multiple standalone header blocks", () => {
        expect(() =>
            parseStructuredAgentText([
                "I will search the web now.",
                toolSegment('BraveWebSearch --query "build a dashboard"'),
                exitSuccessSegment(),
            ].join("\n")),
        ).toThrow(/VALIDATION_ERROR: You emitted 2 structured control blocks/)
    })

})