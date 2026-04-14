import { describe, expect, test } from "vitest"
import {
    formatStructuredControlSegment,
    TOOL_CALL_SEPARATOR_RULE,
    STANDARD_TOOL_CALL_FORMAT_RULES,
    buildStructuredControlValidationError,
    buildMultipleStructuredControlSegmentsValidationError,
    buildShellNativeWorkflowCommandExamples,
    buildBashCommandsSection,
    buildBackgroundBashCommandsSection,
    buildValidationFixReference,
    formatPromptRules,
    SHARED_TOOL_USAGE_RULE,
    buildVoiceToolUsagePrompt,
} from "../src/tool-call-prompts"

describe("formatStructuredControlSegment", () => {
    test("formats bash segment", () => {
        const result = formatStructuredControlSegment("bash", "ls -la")
        expect(result).toBe("---bash---\nls -la")
    })

    test("formats tool segment", () => {
        const result = formatStructuredControlSegment("tool", 'ReadSkill --skill_name "create-app"')
        expect(result).toBe('---tool---\nReadSkill --skill_name "create-app"')
    })

    test("formats background_bash segment", () => {
        const result = formatStructuredControlSegment("background_bash", 'start dev --command "npm start"')
        expect(result).toBe('---background_bash---\nstart dev --command "npm start"')
    })
})

describe("buildShellNativeWorkflowCommandExamples", () => {
    test("includes all defaults", () => {
        const result = buildShellNativeWorkflowCommandExamples()
        expect(result).toContain("rg")
        expect(result).toContain("git")
        expect(result).toContain("bun")
        expect(result).toContain("curl")
    })

    test("excludes git when disabled", () => {
        const result = buildShellNativeWorkflowCommandExamples({ includeGit: false })
        expect(result).not.toContain("git")
        expect(result).toContain("bun")
    })

    test("excludes bun when disabled", () => {
        const result = buildShellNativeWorkflowCommandExamples({ includeBun: false })
        expect(result).not.toContain("bun")
        expect(result).toContain("git")
    })

    test("excludes curl when disabled", () => {
        const result = buildShellNativeWorkflowCommandExamples({ includeCurl: false })
        expect(result).not.toContain("curl")
    })

    test("excludes all optional commands", () => {
        const result = buildShellNativeWorkflowCommandExamples({
            includeGit: false,
            includeBun: false,
            includeCurl: false,
        })
        expect(result).not.toContain("git")
        expect(result).not.toContain("bun")
        expect(result).not.toContain("curl")
        expect(result).toContain("rg")
    })
})

describe("buildStructuredControlValidationError", () => {
    test("prefixes with VALIDATION_ERROR", () => {
        const result = buildStructuredControlValidationError("bad format")
        expect(result).toContain("VALIDATION_ERROR: bad format")
    })

    test("includes fix reference", () => {
        const result = buildStructuredControlValidationError("bad format")
        expect(result).toContain("Fix your response and retry")
    })
})

describe("buildMultipleStructuredControlSegmentsValidationError", () => {
    test("mentions segment count", () => {
        const result = buildMultipleStructuredControlSegmentsValidationError(3)
        expect(result).toContain("3 structured control blocks")
        expect(result).toContain("VALIDATION_ERROR")
    })
})

describe("formatPromptRules", () => {
    test("prefixes each rule with a dash", () => {
        const result = formatPromptRules(["Rule one", "Rule two"])
        expect(result).toBe("- Rule one\n- Rule two")
    })

    test("handles empty array", () => {
        expect(formatPromptRules([])).toBe("")
    })
})

describe("buildValidationFixReference", () => {
    test("includes format and rules", () => {
        const result = buildValidationFixReference("Use JSON", ["Be precise", "No guessing"])
        expect(result).toContain("Fix your response and retry")
        expect(result).toContain("Use JSON")
        expect(result).toContain("- Be precise")
        expect(result).toContain("- No guessing")
    })
})

describe("buildBashCommandsSection", () => {
    test("contains bash header and examples", () => {
        const result = buildBashCommandsSection()
        expect(result).toContain("## Bash Commands")
        expect(result).toContain("---bash---")
    })

    test("accepts custom command examples", () => {
        const result = buildBashCommandsSection({
            shellNativeWorkflowCommandExamples: "rg, sed",
        })
        expect(result).toContain("rg, sed")
    })
})

describe("buildBackgroundBashCommandsSection", () => {
    test("contains background bash header", () => {
        const result = buildBackgroundBashCommandsSection()
        expect(result).toContain("## Background Bash Commands")
        expect(result).toContain("---background_bash---")
    })

    test("includes start/stop/status/logs examples", () => {
        const result = buildBackgroundBashCommandsSection()
        expect(result).toContain("start")
        expect(result).toContain("stop")
        expect(result).toContain("status")
        expect(result).toContain("logs")
    })
})

describe("buildVoiceToolUsagePrompt", () => {
    test("contains voice-specific guidance", () => {
        const result = buildVoiceToolUsagePrompt()
        expect(result).toContain("speak your reasoning")
        expect(result).toContain("---tool---")
    })
})

describe("exported constants", () => {
    test("TOOL_CALL_SEPARATOR_RULE is non-empty", () => {
        expect(TOOL_CALL_SEPARATOR_RULE.length).toBeGreaterThan(0)
    })

    test("STANDARD_TOOL_CALL_FORMAT_RULES has multiple rules", () => {
        expect(STANDARD_TOOL_CALL_FORMAT_RULES.length).toBeGreaterThanOrEqual(4)
    })

    test("SHARED_TOOL_USAGE_RULE is non-empty", () => {
        expect(SHARED_TOOL_USAGE_RULE.length).toBeGreaterThan(0)
    })
})
