import { describe, expect, test } from "vitest"

import { parseAgentResponse } from "../src/agent-response-parser"

const bashSegment = (payload: string) => ["---bash---", payload].join("\n")
const toolSegment = (payload: string) => ["---tool---", payload].join("\n")
const backgroundBashSegment = (payload: string) => ["---background_bash---", payload].join("\n")
const exitSuccessSegment = () => bashSegment("exit 0")
const exitFailureSegment = () => bashSegment("exit 1")

describe("parseAgentResponse", () => {
    test("parses a continue response with bash control segments", () => {
        const content = [
            "Need to read the file first.",
            bashSegment("cat test.ts"),
        ].join("\n")

        const result = parseAgentResponse(content)
        expect(result).not.toBeNull()
        expect(result!.outcome).toBe("continue")
        expect(result!.reasoning).toBe("Need to read the file first.")
        expect(result!.selectedToolCall).toEqual(
            { kind: "bash", name: "Bash", parameters: { command: "cat test.ts" } },
        )
    })

    test("parses a continue response with background bash control segments when allowed", () => {
        const content = [
            "I need to start the preview server without blocking.",
            backgroundBashSegment('start hello --command "bun server.js" --port 3000'),
        ].join("\n")

        const result = parseAgentResponse(content, {
            allowedRunTargets: ["tool", "bash", "background_bash"],
        })
        expect(result).not.toBeNull()
        expect(result!.outcome).toBe("continue")
        expect(result!.reasoning).toBe("I need to start the preview server without blocking.")
        expect(result!.selectedToolCall).toEqual({
            kind: "background_bash",
            name: "BackgroundBash",
            parameters: {
                command: 'start hello --command "bun server.js" --port 3000',
            },
            rawInvocation: 'start hello --command "bun server.js" --port 3000',
        })
    })

    test("parses a continue response with direct tool invocations", () => {
        const content = [
            "I need to load the skill.",
            toolSegment("ReadSkill pencil-design"),
        ].join("\n")

        const result = parseAgentResponse(content)
        expect(result).not.toBeNull()
        expect(result!.outcome).toBe("continue")
        expect(result!.selectedToolCall).toEqual(
            {
                kind: "tool",
                name: "ReadSkill",
                parameters: {},
                rawInvocation: "ReadSkill pencil-design",
            },
        )
    })

    test("parses terminal outcome responses", () => {
        const success = parseAgentResponse([
            "Everything is verified.",
            exitSuccessSegment(),
        ].join("\n"))
        const failure = parseAgentResponse([
            "This cannot be completed with the available tools.",
            exitFailureSegment(),
        ].join("\n"))

        expect(success?.outcome).toBe("success")
        expect(failure?.outcome).toBe("failure")
        expect(success?.selectedToolCall).toBeUndefined()
        expect(failure?.selectedToolCall).toBeUndefined()
    })

    test("parses inline trailing finish segments for compatibility", () => {
        const result = parseAgentResponse("Task complete. ---bash--- exit 0")

        expect(result).not.toBeNull()
        expect(result?.outcome).toBe("success")
        expect(result?.selectedToolCall).toBeUndefined()
        expect(result?.reasoning).toBe("Task complete.")
    })

    test("preserves raw content", () => {
        const content = [
            "Checking the config.",
            bashSegment("cat package.json"),
        ].join("\n")

        expect(parseAgentResponse(content)?.raw).toBe(content)
    })

    test("returns null when no valid control segments exist", () => {
        expect(parseAgentResponse("This is just plain text with no commands")).toBeNull()
        expect(parseAgentResponse("")).toBeNull()
        expect(parseAgentResponse(bashSegment("exit 2"))).toBeNull()
    })

    test("rejects multiple structured control segments in one response", () => {
        const content = [
            "I need both files.",
            bashSegment("cat a.ts"),
            bashSegment("cat b.ts"),
        ].join("\n")

        expect(() => parseAgentResponse(content)).toThrow(/VALIDATION_ERROR: You emitted 2 structured control blocks/)
    })

    test("normalizes a pasted shell prompt marker in multiline heredoc bash commands", () => {
        const content = [
            "I need to write the page.",
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

        const result = parseAgentResponse(content)
        expect(result).not.toBeNull()
        expect(result!.selectedToolCall).toEqual({
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
    })

    test("allows truncated control segments in recovery mode", () => {
        const content = [
            "The command was cut off.",
            bashSegment('cat src/app.ts "'),
        ].join("\n")

        const result = parseAgentResponse(content, { allowTruncatedRuns: true })
        expect(result).not.toBeNull()
        expect(result?.selectedToolCall).toEqual(
            { kind: "bash", name: "Bash", parameters: { command: 'cat src/app.ts "' }, truncated: true },
        )
        expect(result?.outcome).toBe("continue")
    })

    test("recovers truncated direct tool invocations with unterminated quoted args", () => {
        const content = [
            "The tool call was cut off.",
            toolSegment('Read "docs/Read Me.md'),
        ].join("\n")

        const result = parseAgentResponse(content, { allowTruncatedRuns: true })

        expect(result).not.toBeNull()
        expect(result?.selectedToolCall).toEqual(
            {
                kind: "tool",
                name: "Read",
                parameters: {},
                rawInvocation: 'Read "docs/Read Me.md',
                truncated: true,
            },
        )
        expect(result?.outcome).toBe("continue")
    })

    test("parses standalone tool segments", () => {
        const result = parseAgentResponse([
            "Basic path.",
            toolSegment("ReadSkill pencil-design"),
        ].join("\n"))

        expect(result).not.toBeNull()
        expect(result?.selectedToolCall).toEqual({
            kind: "tool",
            name: "ReadSkill",
            parameters: {},
            rawInvocation: "ReadSkill pencil-design",
        })
    })

    test("rejects tool payloads when bash is used as a fake tool name", () => {
        expect(() =>
            parseAgentResponse([
                "Wrong channel.",
                toolSegment("bash --command ls"),
            ].join("\n")),
        ).toThrow(/Use the ---bash--- header instead/)
    })

    test("rejects tool payloads when BackgroundBash is used as a fake tool name", () => {
        expect(() =>
            parseAgentResponse([
                "Wrong channel.",
                toolSegment("BackgroundBash start hello --command bun-server"),
            ].join("\n")),
        ).toThrow(/Use the ---background_bash--- header instead/)
    })

    test("ignores inline header mentions but keeps the final directive as the controlling outcome", () => {
        const content = [
            "The instructions say I should use the ---tool--- header at the end, but that is just explanatory prose.",
            "I will finish cleanly.",
            exitSuccessSegment(),
        ].join("\n")

        const result = parseAgentResponse(content)

        expect(result).not.toBeNull()
        expect(result?.outcome).toBe("success")
        expect(result?.selectedToolCall).toBeUndefined()
        expect(result?.reasoning).toContain("The instructions say I should use")
    })

    test("ignores inline header mentions inside analysis paragraphs", () => {
        const content = [
            "The tools mention the ---tool--- and ---bash--- headers, but neither should be executed from this sentence.",
            "Need to inspect the file first.",
            bashSegment("cat test.ts"),
        ].join("\n")

        const result = parseAgentResponse(content)

        expect(result).not.toBeNull()
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual(
            { kind: "bash", name: "Bash", parameters: { command: "cat test.ts" } },
        )
    })
})
