import { describe, expect, test } from "vitest"

import {
    VALIDATION_FIX_REFERENCE,
    ERROR_TRUNCATED_RESPONSE,
    formatZodValidationError,
    buildValidationErrorMessage,
    buildNoStructuredResponseFoundError,
    recoverTruncatedResponse,
    buildParseFeedback,
    parseResponseWithRecovery,
} from "../src/tool-call-recovery"

const bashSegment = (payload: string) => ["---bash---", payload].join("\n")
const toolSegment = (payload: string) => ["---tool---", payload].join("\n")
const exitSuccessSegment = () => bashSegment("exit 0")

const failedMonacoGlassConversationExample = [
    "I need to create the landing page.",
    bashSegment([
        "$ cat > apps/monaco-glass/index.html << 'HTMLEOF'",
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="UTF-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        '  <title>Monaco Glass | Architectural Excellence</title>',
        '  <link rel="preconnect" href="https://fonts.googleapis.com">',
        '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
        '  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Outfit:wght@300;400;500&display=swap" rel="stylesheet">',
        "  <style>",
        "    :root {",
        "      --color-ivory: #F8F6F3;",
        "      --color-stone: #E8E4DF;",
        "      --color-charcoal: #2C2C2C;",
        "      --color-graphite: #4A4A4A;",
        "      --color-silver: #8A8A8A;",
        "      --color-pearl: #FAFAF8;",
        "      --color-gold: #B8956E;",
        "      --font-display: 'Cormorant Garamond', Georgia, serif;",
        "      --font-body: 'Outfit', system-ui, sans-serif;",
        "      --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);",
        "    }",
        "  </style>",
        "</head>",
        "<body>",
        '  <nav id="nav">',
        '    <a href="#" class="logo">Monaco Glass</a>',
        "  </nav>",
        "</body>",
        "</html>",
        "HTMLEOF",
    ].join("\n")),
    "[SYSTEM_EXEC:03:34:52]",
    "The shell is interpreting parts of the HTML as bash commands due to special characters. I need to escape the content better or use a different approach. Let me try writing the file with proper escaping.",
].join("\n")

const failedSmartGlassesConversationExample = [
    "Now I'll create the landing page for AI smart glasses. I need to create a compelling, visually stunning landing page. Let me craft an impressive index.html file with modern design, animations, and great copy.",
    bashSegment([
        "cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'",
        "",
        '<html lang="en">',
        "",
        ' <meta charset="UTF-8">',
        ' <meta name="viewport" content="width=device-width, initial-scale=1.0">',
        ' LUMINA — AI Smart Glasses That See Tomorrow',
        ' <link rel="preconnect" href="https://fonts.googleapis.com">',
        ' [blocked] <link rel="preconnect" href="https://fonts.gstatic.com\ [blocked]" crossorigin>',
        ' <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">',
        " ",
        " *, *::before, ::after {",
        " margin: 0;",
        " padding: 0;",
        " box-sizing: border-box;",
        " }",
        "",
        " :root {",
        " --bg-dark: #0a0a0f;",
        " --bg-card: #12121a;",
        " --accent: #6366f1;",
        " --accent-glow: rgba(99, 102, 241, 0.4);",
        " --text-primary: #ffffff;",
        " --text-secondary: rgba(255, 255, 255, 0.6);",
        " --text-muted: rgba(255, 255, 255, 0.4);",
        " }",
        "",
        " html {",
        " scroll-behavior: smooth;",
        " }",
        "",
        " body {",
        " font-family: 'Inter', -apple-system, sans-serif;",
        " background: var(--bg-dark);",
        " color: var(--text-primary);",
        " line-height: 1.6;",
        " overflow-x: hidden;",
        " }",
        "",
        " / Navigation /",
        " nav {",
        " position: fixed;",
        " top: 0;",
        " left: 0;",
        " right: 0;",
        " z-index: 1000;",
        " padding: 1.5rem 4rem;",
        " display: flex;",
        " justify-content: space-between;",
        " align-items: center;",
        " background: rgba(10, 10, 15, 0.8);",
        " backdrop-filter: blur(20px);",
        " border-bottom: 1px solid rgba(255, 255, 255, 0.05);",
        " }",
        "",
        "HTMLEOF",
    ].join("\n")),
    `[TOOL_LOG:Bash:05:14:48]
OPEN
$ cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'\n<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>LUMINA — AI Smart Glasses That See Tomorrow</title>\n    <link rel="preconnect" href="https://fonts.googleapis.com">\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">\n    <style>\n        *, *::before, *::after {\n            margin: 0;\n            padding: 0;\n            box-sizing: border-box;\n        }\n    </style>\n</head>\n<body>\n    <nav>\n        <div class="logo">LUMINA</div>\n    </nav>\n</body>\n</html>\nHTMLEOF
[stderr]
bash: !: No such file or directory
bash: 500: command not found
bash: style: No such file or directory
[meta] tool="cat" route="bash"
[exit:127 | 39ms]`,
].join("\n")

const failedLuminaConversationExample = [
`Now I'll create the index.html file with a sophisticated, distinctive design for a smart glasses startup. Let me craft something memorable.
I'll name it "Lumina" - a smart glasses brand. The aesthetic will be:

Warm, editorial feel (not cold tech)
Copper/amber accents against cream/off-white
Sophisticated serif + sans-serif pairing
Asymmetric layouts
High-end fashion brand vibes mixed with subtle tech elements
${bashSegment([
    "cat > apps/lumina-glasses/index.html << 'HTMLEOF'",
    "",
    '<html lang="en">',
    "",
    ' <meta charset="UTF-8">',
    ' <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    ' Lumina — Smart Glasses Reimagined',
    ' <link rel="preconnect" href="https://fonts.googleapis.com">',
    ' [blocked] <link rel="preconnect" href="https://fonts.gstatic.com\ [blocked]" crossorigin>',
    ' <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet">',
    " ",
    " :root {",
    " --cream: #FAF7F2;",
    " --cream-dark: #EDE8DF;",
    " --charcoal: #1A1918;",
    " --charcoal-light: #2D2B2A;",
    " --copper: #B87333;",
    " --copper-dark: #9A5F2A;",
    " --stone: #6B6560;",
    " --font-display: 'Cormorant Garamond', Georgia, serif;",
    " --font-body: 'DM Sans', system-ui, sans-serif;",
    " }",
    "",
    " *, *::before, ::after {",
    " margin: 0;",
    " padding: 0;",
    " box-sizing: border-box;",
    " }",
    "",
    " ::selection {",
    " background: var(--copper);",
    " color: var(--cream);",
    " }",
    "",
    " html {",
    " scroll-behavior: smooth;",
    " }",
    "",
    " body {",
    " font-family: var(--font-body);",
    " background: var(--cream);",
    " color: var(--charcoal);",
    " line-height: 1.6;",
    " overflow-x: hidden;",
    " }",
    "",
    " / Navigation /",
    " nav {",
    " position: fixed;",
    " top: 0;",
    " left: 0;",
    " right: 0;",
    " z-index: 100;",
    " padding: 1.5rem 3rem;",
    " display: flex;",
    " justify-content: space-between;",
    " align-items: center;",
    " background: linear-gradient(to bottom, var(--cream) 0%, transparent 100%);",
    " }",
    "",
    "HTMLEOF",
].join("\n"))}`,
    `[AGENT_FEEDBACK:ERROR:14:01:25]
CLOSED
    Your response did not end with an executable control block. Reply with normal prose and, if you are acting, one final standalone header block such as ---tool---, ---bash---, or ---background_bash---. Put the header on its own line and put the payload on the following line(s). Use ---bash--- with exit 0 or exit 1 only when finishing. Do not discuss the control syntax.`,
].join("\n")

const failedHelloWorldConversationExample = [
    "I need to create the hello world page.",
    bashSegment([
        "$ cat > index.html << 'EOF'",
        "<!DOCTYPE html>",
        "<html lang=\"en\">",
        "<head>",
        "  <meta charset=\"UTF-8\">",
        "  <title>Hello World</title>",
        "</head>",
        "<body>",
        "  <h1>Hello World</h1>",
        "</body>",
        "</html>",
        "EOF",
        "",
        "I'll verify the file was created correctly.",
        "[stderr]",
        "bash: line 291: unexpected EOF while looking for matching `''",
        "[meta] tool=\"bash\" route=\"bash\"",
        "[exit:2 | 8ms]",
        "[SYSTEM_EXEC:14:42:31]",
        "The heredoc had an issue - there was likely a problem with the closing EOF marker or an unterminated string. Let me fix this by writing the file properly using a different approach.",
    ].join("\n")),
].join("\n")

describe("constants", () => {
    test("validation reference describes the shared control-segment contract", () => {
        expect(VALIDATION_FIX_REFERENCE).toContain('Write normal prose and end with exactly one final executable control block.')
        expect(VALIDATION_FIX_REFERENCE).toContain('put the standalone slug header on its own line')
        expect(VALIDATION_FIX_REFERENCE).toContain('Do not mention the control headers anywhere else')
        expect(VALIDATION_FIX_REFERENCE).toContain(
            'If continuing, end with exactly one real action block.',
        )
        expect(VALIDATION_FIX_REFERENCE).toContain(
            'If finishing, end with exactly one final ---bash--- control block whose payload is either exit 0 or exit 1.',
        )
        expect(VALIDATION_FIX_REFERENCE).toContain(
            'Do not mention, quote, or explain the control headers in analysis or summaries.',
        )
    })

    test("truncation error contains actionable tool-call guidance", () => {
        expect(ERROR_TRUNCATED_RESPONSE).toContain("VALIDATION_ERROR")
        expect(ERROR_TRUNCATED_RESPONSE).toContain('final executable control block')
        expect(ERROR_TRUNCATED_RESPONSE).toContain('Do not discuss the control syntax')
    })
})

describe("formatZodValidationError", () => {
    test("formats Zod-style issues arrays", () => {
        const zodError = {
            issues: [
                {
                    path: ["outcome"],
                    message: "Required",
                    code: "invalid_type",
                    received: undefined,
                    expected: "string",
                },
                {
                    path: ["selectedToolCall", "name"],
                    message: "Expected string",
                    code: "invalid_type",
                    received: 42,
                    expected: "string",
                },
            ],
        }

        const result = formatZodValidationError(zodError)
        expect(result).toContain("terminal state")
        expect(result).toContain('---bash---')
        expect(result).toContain('only final responses use')
        expect(result).toContain("selectedToolCall.name")
        expect(result).toContain("you sent: 42")
    })

    test("handles generic errors", () => {
        expect(formatZodValidationError(new Error("parse failed"))).toContain(
            "Response parse error: parse failed",
        )
    })
})

describe("buildValidationErrorMessage", () => {
    test("combines field details with the shared fix reference", () => {
        const result = buildValidationErrorMessage({
            issues: [
                {
                    path: ["outcome"],
                    message: "Required",
                    code: "invalid_type",
                    received: undefined,
                    expected: "string",
                },
            ],
        })

        expect(result).toContain("VALIDATION_ERROR")
        expect(result).toContain("terminal state")
        expect(result).toContain(VALIDATION_FIX_REFERENCE)
    })
})

describe("buildNoStructuredResponseFoundError", () => {
    test("mentions missing structured control segments without echoing raw response text", () => {
        const result = buildNoStructuredResponseFoundError()
        expect(result).toContain('did not end with an executable control block')
        expect(result).toContain('Do not discuss the control syntax')
        expect(result).toContain(VALIDATION_FIX_REFERENCE)
        expect(result).not.toContain("give me a second")
    })
})

describe("recoverTruncatedResponse", () => {
    test("recovers truncated control segments", () => {
        const content = [
            "I need to inspect the file.",
            bashSegment('cat src/app.ts "'),
        ].join("\n")

        const result = recoverTruncatedResponse(content)
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual(
            { kind: "bash", name: "Bash", parameters: { command: 'cat src/app.ts "' }, truncated: true },
        )
        expect(result?.reasoning).toBe("I need to inspect the file.")
    })

    test("recovers truncated direct tool invocations", () => {
        const content = [
            "I need to open the file.",
            toolSegment('Read "docs/Read Me.md'),
        ].join("\n")

        const result = recoverTruncatedResponse(content)
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual(
            {
                kind: "tool",
                name: "Read",
                parameters: {},
                rawInvocation: 'Read "docs/Read Me.md',
                truncated: true,
            },
        )
        expect(result?.reasoning).toBe("I need to open the file.")
    })

    test("returns null for plain prose with no commands", () => {
        expect(recoverTruncatedResponse("This is just plain English.")).toBeNull()
    })

    test("recovers malformed multiline heredoc bash commands and trims transcript artifacts", () => {
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
            "[SYSTEM_EXEC:03:34:52]",
            "The shell is interpreting parts of the HTML as bash commands.",
        ].join("\n")

        const result = recoverTruncatedResponse(content)
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual({
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
})

describe("buildParseFeedback", () => {
    test("returns validation-specific feedback when zod details are provided", () => {
        const result = buildParseFeedback("bad response", {
            issues: [
                {
                    path: ["outcome"],
                    message: "Required",
                    code: "invalid_type",
                    received: undefined,
                    expected: "string",
                },
            ],
        })
        expect(result).toContain("VALIDATION_ERROR")
        expect(result).toContain("terminal state")
    })

    test("reuses the no-structured-response guidance otherwise", () => {
        const result = buildParseFeedback("some invalid content")
        expect(result).toContain('did not end with an executable control block')
        expect(result).toContain(VALIDATION_FIX_REFERENCE)
    })

    test("passes through explicit validation feedback for misrouted bash tool calls", () => {
        const result = buildParseFeedback(
            toolSegment("bash --command ls"),
            new Error(
                'VALIDATION_ERROR: Bash is not a registered tool name. You wrote a tool payload with a bash command. Use the ---bash--- header instead.',
            ),
        )

        expect(result).toContain("Bash is not a registered tool name")
        expect(result).toContain('Use the ---bash--- header instead')
    })
})

describe("parseResponseWithRecovery", () => {
    test("parses a valid bash response", () => {
        const content = [
            "Checking the file.",
            bashSegment("cat src/app.ts"),
        ].join("\n")

        const result = parseResponseWithRecovery(content)
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual(
            { kind: "bash", name: "Bash", parameters: { command: "cat src/app.ts" } },
        )
    })

    test("recovers a truncated response when finishReason is length", () => {
        const content = [
            "I need to inspect the file.",
            bashSegment('cat src/app.ts "'),
        ].join("\n")

        const result = parseResponseWithRecovery(content, { finishReason: "length" })
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual(
            { kind: "bash", name: "Bash", parameters: { command: 'cat src/app.ts "' }, truncated: true },
        )
    })

    test("recovers truncated direct tool responses when finishReason is length", () => {
        const content = [
            "I need to open the file.",
            toolSegment('Read "docs/Read Me.md'),
        ].join("\n")

        const result = parseResponseWithRecovery(content, { finishReason: "length" })
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual(
            {
                kind: "tool",
                name: "Read",
                parameters: {},
                rawInvocation: 'Read "docs/Read Me.md',
                truncated: true,
            },
        )
    })

    test("throws validation feedback for misrouted bash tool syntax", () => {
        expect(() =>
            parseResponseWithRecovery(toolSegment("bash --command ls")),
        ).toThrow(/VALIDATION_ERROR: Bash is not a registered tool name/)
    })

    test("throws validation feedback for multiple standalone slug segments", () => {
        expect(() =>
            parseResponseWithRecovery([
                "I need to inspect two files.",
                bashSegment("cat a.ts"),
                toolSegment('Read "b.ts"'),
            ].join("\n")),
        ).toThrow(/VALIDATION_ERROR: You emitted 2 structured control blocks/)
    })

    test("returns null when no control segments can be extracted", () => {
        expect(parseResponseWithRecovery("Just prose, no commands here.")).toBeNull()
    })

    test("recovers malformed standalone heredoc bash commands even without finishReason length", () => {
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
            "[SYSTEM_EXEC:03:34:52]",
            "The shell is interpreting parts of the HTML as bash commands.",
        ].join("\n")

        const result = parseResponseWithRecovery(content)
        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual({
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

    test("recovers the failed Monaco Glass convo example with transcript junk appended", () => {
        const result = parseResponseWithRecovery(failedMonacoGlassConversationExample)

        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > apps/monaco-glass/index.html << 'HTMLEOF'",
                    "<!DOCTYPE html>",
                    '<html lang="en">',
                    "<head>",
                    '  <meta charset="UTF-8">',
                    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
                    '  <title>Monaco Glass | Architectural Excellence</title>',
                    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
                    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
                    '  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Outfit:wght@300;400;500&display=swap" rel="stylesheet">',
                    "  <style>",
                    "    :root {",
                    "      --color-ivory: #F8F6F3;",
                    "      --color-stone: #E8E4DF;",
                    "      --color-charcoal: #2C2C2C;",
                    "      --color-graphite: #4A4A4A;",
                    "      --color-silver: #8A8A8A;",
                    "      --color-pearl: #FAFAF8;",
                    "      --color-gold: #B8956E;",
                    "      --font-display: 'Cormorant Garamond', Georgia, serif;",
                    "      --font-body: 'Outfit', system-ui, sans-serif;",
                    "      --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);",
                    "    }",
                    "  </style>",
                    "</head>",
                    "<body>",
                    '  <nav id="nav">',
                    '    <a href="#" class="logo">Monaco Glass</a>',
                    "  </nav>",
                    "</body>",
                    "</html>",
                    "HTMLEOF",
                ].join("\n"),
            },
        })
        expect(result?.reasoning).toBe("I need to create the landing page.")
    })

    test("recovers the failed smart-glasses convo example from escaped quoted bash and tool-log fallout", () => {
        const result = parseResponseWithRecovery(failedSmartGlassesConversationExample)

        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toMatchObject({
            kind: "bash",
            name: "Bash",
            parameters: {},
        })

        const recoveredCommand = result?.selectedToolCall?.parameters.command
        expect(typeof recoveredCommand).toBe("string")
        expect(recoveredCommand).toContain("cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'")
        expect(recoveredCommand).toContain('<html lang="en">')
        expect(recoveredCommand).toContain('LUMINA — AI Smart Glasses That See Tomorrow')
        expect(recoveredCommand).toContain('background: var(--bg-dark);')
        expect(recoveredCommand).toContain("HTMLEOF")
    })

    test("recovers bash commands directly from tool logs when the original control segment is unparseable", () => {
        const content = [
            "I need to create the landing page.",
            bashSegment("cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'\n<div class=\"logo\">LUMINA</div>\n\""),
            "",
            "[TOOL_LOG:Bash:05:14:48]",
            "OPEN",
            String.raw`$ cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'\n<!DOCTYPE html>\n<div class="logo">LUMINA</div>\nHTMLEOF`,
            "[stderr]",
            "bash: !: No such file or directory",
            '[meta] tool="cat" route="bash"',
            "[exit:127 | 39ms]",
        ].join("\n")

        const result = parseResponseWithRecovery(content)

        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > apps/smart-glasses-landing/index.html << 'HTMLEOF'",
                    "<!DOCTYPE html>",
                    '<div class="logo">LUMINA</div>',
                    "HTMLEOF",
                ].join("\n"),
            },
        })
    })

    test("recovers the failed Lumina convo example with malformed quoted bash and agent feedback appended", () => {
        const result = parseResponseWithRecovery(failedLuminaConversationExample)

        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toMatchObject({
            kind: "bash",
            name: "Bash",
            parameters: {},
        })

        const recoveredCommand = result?.selectedToolCall?.parameters.command
        expect(typeof recoveredCommand).toBe("string")
        expect(recoveredCommand).toContain("cat > apps/lumina-glasses/index.html << 'HTMLEOF'")
        expect(recoveredCommand).toContain('<html lang="en">')
        expect(recoveredCommand).toContain('Lumina — Smart Glasses Reimagined')
        expect(recoveredCommand).toContain('--font-display: \'Cormorant Garamond\', Georgia, serif;')
        expect(recoveredCommand).toContain('background: linear-gradient(to bottom, var(--cream) 0%, transparent 100%);')
        expect(recoveredCommand).toContain('HTMLEOF')
    })

    test("recovers heredoc commands when natural-language fallout appears before stderr markers", () => {
        const result = parseResponseWithRecovery(failedHelloWorldConversationExample)

        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: {
                command: [
                    "cat > index.html << 'EOF'",
                    "<!DOCTYPE html>",
                    '<html lang="en">',
                    "<head>",
                    '  <meta charset="UTF-8">',
                    "  <title>Hello World</title>",
                    "</head>",
                    "<body>",
                    "  <h1>Hello World</h1>",
                    "</body>",
                    "</html>",
                    "EOF",
                ].join("\n"),
            },
        })
    })

    test("prefers a corrected trailing bash invocation after earlier bash alias validation errors", () => {
        const content = [
            "[SYSTEM_EXEC:04:39:08]",
            "The user wants me to list all files in the current working directory. I'll use bash to do this.",
            "I'll list all files in the current working directory. I first tried to route bash through a tool payload.",
            "",
            "[AGENT_FEEDBACK:ERROR:04:39:08]",
            "OPEN",
            "Bash is not a registered tool name. You wrote a tool payload with a bash command. Use the ---bash--- header instead.",
            "[SYSTEM_EXEC:04:39:09]",
            "The user is reminding me about the correct syntax for bash commands. I should use the ---bash--- header instead of a tool payload. Let me correct that.",
            "I'll correct that and list all files using the proper syntax.",
            bashSegment("ls -la"),
        ].join("\n")

        const result = parseResponseWithRecovery(content)

        expect(result?.outcome).toBe("continue")
        expect(result?.selectedToolCall).toEqual({
            kind: "bash",
            name: "Bash",
            parameters: { command: "ls -la" },
        })
        expect(result?.reasoning).toContain("I'll correct that and list all files using the proper syntax.")
    })
})
