import { describe, expect, test } from "vitest"

import { StreamingToolParser } from "../src/streaming-tool-parser"
import type { ToolCall } from "../src/types"

const bashSegment = (payload: string) => ["---bash---", payload].join("\n")
const toolSegment = (payload: string) => ["---tool---", payload].join("\n")
const backgroundBashSegment = (payload: string) => ["---background_bash---", payload].join("\n")
const exitSuccessSegment = () => bashSegment("exit 0")

describe("StreamingToolParser", () => {
    test("does not emit tool calls before finish", () => {
        const parser = new StreamingToolParser()
        const emittedCalls: ToolCall[] = []

        parser.on({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push([
            "I now know which notes to inspect.",
            bashSegment("cat src/app.ts"),
        ].join("\n"))

        expect(emittedCalls).toEqual([])

        parser.finish()

        expect(emittedCalls).toEqual([
            { kind: "bash", name: "Bash", parameters: { command: "cat src/app.ts" } },
        ])
    })

    test("parses standalone bash segments after stream completion", () => {
        const parser = new StreamingToolParser()
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []

        parser.on({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push(bashSegment("cat src/app.ts"))
        parser.finish()

        expect(emittedCalls).toEqual([
            {
                kind: "bash",
                name: "Bash",
                parameters: { command: "cat src/app.ts" },
            },
        ])
        expect(parseErrors).toEqual([])
    })

    test("parses same-line payloads when the slug header starts its own control line", () => {
        const parser = new StreamingToolParser()
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []

        parser.on({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push(["Task complete.", "---bash--- exit 0"].join("\n"))
        parser.finish()

        expect(emittedCalls).toEqual([])
        expect(parseErrors).toEqual([])
    })

    test("parses multiline bash heredoc segments with inner html quotes when the stream finishes", () => {
        const parser = new StreamingToolParser()
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []

        parser.on({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push([
            "I need to create the landing page.",
            bashSegment([
                "cat > apps/lumina-glasses/index.html << 'HTMLEOF'",
                "",
                '<html lang="en">',
                "",
                ' <meta charset="UTF-8">',
                " Lumina — Smart Glasses Reimagined",
                ' <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond&display=swap" rel="stylesheet">',
                "",
                " :root {",
                " --cream: #FAF7F2;",
                " }",
                "",
                "HTMLEOF",
            ].join("\n")),
        ].join("\n"))
        parser.finish()

        expect(parseErrors).toEqual([])
        expect(emittedCalls).toEqual([
            {
                kind: "bash",
                name: "Bash",
                parameters: {
                    command: [
                        "cat > apps/lumina-glasses/index.html << 'HTMLEOF'",
                        "",
                        '<html lang="en">',
                        "",
                        ' <meta charset="UTF-8">',
                        " Lumina — Smart Glasses Reimagined",
                        ' <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond&display=swap" rel="stylesheet">',
                        "",
                        " :root {",
                        " --cream: #FAF7F2;",
                        " }",
                        "",
                        "HTMLEOF",
                    ].join("\n"),
                },
            },
        ])
    })

    test("surfaces a validation error when bash is routed through a tool payload", () => {
        const parser = new StreamingToolParser()
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []

        parser.on({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push(toolSegment("bash --command ls"))
        parser.finish()

        expect(emittedCalls).toEqual([])
        expect(parseErrors).toEqual([
            {
                message: 'VALIDATION_ERROR: Bash is not a registered tool name. You wrote a tool payload with a bash command. Use the ---bash--- header instead.',
                rawCommandText: toolSegment("bash --command ls"),
            },
        ])
    })

    test("keeps the corrected trailing bash segment after earlier inline alias guidance in the same streamed content", () => {
        const parser = new StreamingToolParser()
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []

        parser.on({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push([
            "[SYSTEM_EXEC:04:39:08]",
            "The user wants me to list all files in the current working directory. I'll use bash to do this.",
            "I'll list all files in the current working directory. The tool payload route is wrong for bash.",
            "",
            "[AGENT_FEEDBACK:ERROR:04:39:08]",
            "OPEN",
            "Bash is not a registered tool name. You wrote a tool payload with a bash command. Use the ---bash--- header instead.",
            "[SYSTEM_EXEC:04:39:09]",
            "The user is reminding me about the correct syntax for bash commands.",
            bashSegment("ls -la"),
        ].join("\n"))
        parser.finish()

        expect(parseErrors).toEqual([])
        expect(emittedCalls).toEqual([
            {
                kind: "bash",
                name: "Bash",
                parameters: { command: "ls -la" },
            },
        ])
    })

    test("parses speech followed by a bash control segment without false parse errors", () => {
        const content = [
            "I now know which notes to inspect.",
            bashSegment('search "partner readiness"'),
        ].join("\n")

        const speechTokens: string[] = []
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []

        const parser = new StreamingToolParser({
            onSpeechToken: (token) => {
                speechTokens.push(token)
            },
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({
                    message: error.message,
                    rawCommandText,
                })
            },
        })

        for (const char of content) {
            parser.push(char)
        }
        parser.finish()

        expect(parseErrors).toHaveLength(0)
        expect(speechTokens.join("")).toBe("I now know which notes to inspect.\n")
        expect(emittedCalls).toHaveLength(1)
        expect(emittedCalls[0]).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: 'search "partner readiness"',
            },
        })
    })

    test("parses raw multiline bash invocations once the stream finishes", () => {
        const content = [
            "Let me run a short script.",
            bashSegment([
                "python - <<'PY'",
                "print('ok')",
                "PY",
            ].join("\n")),
        ].join("\n")

        const speechTokens: string[] = []
        const emittedCalls: ToolCall[] = []

        const parser = new StreamingToolParser({
            onSpeechToken: (token) => {
                speechTokens.push(token)
            },
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        for (const char of content) {
            parser.push(char)
        }
        parser.finish()

        expect(speechTokens.join("")).toBe("Let me run a short script.\n")
        expect(emittedCalls).toEqual([
            {
                kind: "bash",
                name: "Bash",
                parameters: {
                    command: "python - <<'PY'\nprint('ok')\nPY",
                },
            },
        ])
    })

    test("normalizes a pasted shell prompt marker in multiline heredoc bash invocations", () => {
        const content = [
            "Let me write the file.",
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
        ].join("\n")

        const emittedCalls: ToolCall[] = []
        const parser = new StreamingToolParser({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push(content)
        parser.finish()

        expect(emittedCalls).toEqual([
            {
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
            },
        ])
    })

    test("parses background bash invocations once the stream finishes when allowed", () => {
        const emittedCalls: ToolCall[] = []

        const parser = new StreamingToolParser({
            allowedRunTargets: ["tool", "bash", "background_bash"],
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push([
            "I need to start the preview server.",
            backgroundBashSegment('start hello --command "bun server.js" --port 3000'),
        ].join("\n"))
        parser.finish()

        expect(emittedCalls).toEqual([
            {
                kind: "background_bash",
                name: "BackgroundBash",
                parameters: {
                    command: 'start hello --command "bun server.js" --port 3000',
                },
                rawInvocation: 'start hello --command "bun server.js" --port 3000',
            },
        ])
    })

    test("recovers a truncated control payload when the stream ends", () => {
        const content = [
            "Let me inspect that file.",
            bashSegment('cat src/app.ts "'),
        ].join("\n")

        const speechTokens: string[] = []
        const emittedCalls: ToolCall[] = []

        const parser = new StreamingToolParser({
            onSpeechToken: (token) => {
                speechTokens.push(token)
            },
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push(content)
        parser.finish()

        expect(speechTokens.join("")).toBe("Let me inspect that file.\n")
        expect(emittedCalls).toEqual([
            { kind: "bash", name: "Bash", parameters: { command: 'cat src/app.ts "' }, truncated: true },
        ])
    })

    test("recovers malformed heredoc bash commands and drops transcript artifacts when the stream ends", () => {
        const content = [
            "Let me write the file.",
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
            "[SYSTEM_EXEC:03:34:52]",
            "The shell is interpreting parts of the HTML as bash commands.",
        ].join("\n")

        const emittedCalls: ToolCall[] = []
        const parser = new StreamingToolParser({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push(content)
        parser.finish()

        expect(emittedCalls).toEqual([
            {
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
            },
        ])
    })

    test("drops natural-language fallout after a heredoc terminator when transcript markers follow", () => {
        const content = [
            "Let me write the file.",
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
        ].join("\n")

        const emittedCalls: ToolCall[] = []
        const parser = new StreamingToolParser({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push(content)
        parser.finish()

        expect(emittedCalls).toEqual([
            {
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
                truncated: true,
            },
        ])
    })

    test("repairs missing heredoc terminators with template-literal content when the stream ends", () => {
        const content = [
            "Let me create the app.",
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
        ].join("\n")

        const emittedCalls: ToolCall[] = []
        const parser = new StreamingToolParser({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push(content)
        parser.finish()

        expect(emittedCalls).toEqual([
            {
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
                truncated: true,
            },
        ])
    })

    test("collapses duplicate heredoc terminators when the stream ends", () => {
        const content = [
            "Let me create the app.",
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
        ].join("\n")

        const emittedCalls: ToolCall[] = []
        const parser = new StreamingToolParser({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push(content)
        parser.finish()

        expect(emittedCalls).toEqual([
            {
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
            },
        ])
    })

    test("buffers incomplete direct tool invocations until finish before recovering them", () => {
        const speechTokens: string[] = []
        const emittedCalls: ToolCall[] = []

        const parser = new StreamingToolParser({
            onSpeechToken: (token) => {
                speechTokens.push(token)
            },
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
        })

        parser.push("Open the file.\n")
        parser.push(toolSegment('Read "docs/Read Me.md'))

        expect(emittedCalls).toEqual([])

        parser.finish()

        expect(speechTokens.join("")).toBe("Open the file.\n")
        expect(emittedCalls).toEqual([
            {
                kind: "tool",
                name: "Read",
                parameters: {},
                rawInvocation: 'Read "docs/Read Me.md',
                truncated: true,
            },
        ])
    })

    test("does not treat terminal outcome lines as tool-call parse errors", () => {
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []
        const parser = new StreamingToolParser({
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push(['All done.', exitSuccessSegment()].join('\n'))
        parser.finish()

        expect(parseErrors).toEqual([])
    })

    test("aborts on a second structured control segment and keeps only the first one", () => {
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []
        const parser = new StreamingToolParser({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push([
            "I should check both files.",
            bashSegment("cat a.ts"),
            bashSegment("cat b.ts"),
        ].join("\n"))

        expect(parser.sealed).toBe(true)
        expect(parser.getFullContent()).toBe([
            "I should check both files.",
            bashSegment("cat a.ts"),
        ].join("\n"))
        expect(emittedCalls).toEqual([
            {
                kind: "bash",
                name: "Bash",
                parameters: { command: "cat a.ts" },
            },
        ])
        expect(parseErrors).toEqual([])

        parser.finish()

        expect(emittedCalls).toEqual([
            {
                kind: "bash",
                name: "Bash",
                parameters: { command: "cat a.ts" },
            },
        ])
        expect(parseErrors).toEqual([])
    })

    test("does not emit tool calls when the final extracted directive is an exit segment", () => {
        const emittedCalls: ToolCall[] = []
        const parseErrors: Array<{ message: string; rawCommandText: string }> = []
        const parser = new StreamingToolParser({
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onToolCallError: (error, rawCommandText) => {
                parseErrors.push({ message: error.message, rawCommandText })
            },
        })

        parser.push([
            "The instructions mention the ---tool--- header in prose.",
            exitSuccessSegment(),
        ].join("\n"))
        parser.finish()

        expect(emittedCalls).toEqual([])
        expect(parseErrors).toEqual([])
    })

    test("waits until finish before sealing so multiline payloads can continue streaming", () => {
        const speechTokens: string[] = []
        const emittedCalls: ToolCall[] = []
        const logs: string[] = []

        const parser = new StreamingToolParser({
            onSpeechToken: (token) => {
                speechTokens.push(token)
            },
            onToolCall: (selectedToolCall) => {
                emittedCalls.push(selectedToolCall)
            },
            onLog: (msg) => {
                logs.push(msg)
            },
        })

        const content = [
            "Let me check.",
            bashSegment([
                "cat > notes.txt << 'EOF'",
                "alpha",
                "beta",
                "EOF",
            ].join("\n")),
        ].join("\n")

        for (const char of content) {
            parser.push(char)
        }

        expect(parser.sealed).toBe(false)
        expect(parser.getFullContent()).toBe(content)

        parser.finish()

        expect(emittedCalls).toHaveLength(1)
        expect(emittedCalls[0]).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > notes.txt << 'EOF'",
                    "alpha",
                    "beta",
                    "EOF",
                ].join("\n"),
            },
        })
    })
})