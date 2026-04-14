import { describe, expect, test } from "vitest"

import {
    formatToolsSection,
    buildAgentSystemPrompt,
    buildToolAwareSystemPrompt,
    buildCoreStaticRules,
    buildSkillAwareStaticContext,
    buildWorkspaceCodingStaticRules,
    buildAgentIdentityLine,
    buildWebRuntimeRules,
    buildValidationRecoveryRuleLines,
    buildStepUserMessage,
    createAppendToolsSectionCustomizer,
    createToolsSectionOverrideCustomizer,
    extractTruncatedToolInfo,
    DEFAULT_AGENT_FALLBACK_SYSTEM_PROMPT,
    CODE_QUALITY_RULE_LINE,
    INCREMENTAL_TESTING_RULE_LINE,
    PORT_CONFLICT_RULE_LINE,
    SKILL_INVOKE_READ_RULE_LINE,
} from "../src/prompt-helpers"
import {
    BACKGROUND_BASH_START_EXAMPLE_LINE,
    JUST_BASH_SCRIPT_EXECUTION_RESTRICTION_LINES,
    JUST_BASH_SHELL_NATIVE_WORKFLOW_COMMAND_EXAMPLES,
    SHALLOW_WORKSPACE_DISCOVERY_RULE_LINE,
    SHARED_TOOL_USAGE_RULE,
    SHELL_NATIVE_WORKFLOW_COMMAND_EXAMPLES,
    WORKSPACE_CONTEXT_GATHERING_COMMAND_EXAMPLES,
} from "../src/tool-call-prompts"
import type { ToolDefinition } from "../src/types"

describe("prompt-helpers", () => {
    const tools: ToolDefinition[] = [
        {
            name: "Read",
            description: "Read a file",
            usageExample: 'Read README.md',
            parameters: {
                path: { type: "string", description: "File path", required: true },
            },
        },
    ]

    test("formatToolsSection documents the tool and bash contract", () => {
        const result = formatToolsSection(tools, {
            bashAvailable: true,
        })

        expect(result).toContain('## Registered Tools')
        expect(result).toContain("Read <path>")
        expect(result).toContain('Example: `Read README.md`')
        expect(result).toContain("---bash---\nsed -n '1,120p' README.md")
        expect(result).toContain(`Use bash for shell-native workflows such as ${SHELL_NATIVE_WORKFLOW_COMMAND_EXAMPLES}.`)
        expect(result).toContain(SHALLOW_WORKSPACE_DISCOVERY_RULE_LINE)
        expect(result).toContain('Never start a tool payload with Bash --command ...; use the ---bash--- header instead.')
    })

    test("formatToolsSection does not advertise a ui command surface", () => {
        const result = formatToolsSection(tools)

        expect(result).toContain('## Registered Tools')
        expect(result).toContain('Example: `Read README.md`')
    })

    test("formatToolsSection omits bash guidance when bash is unavailable", () => {
        const result = formatToolsSection(tools)

        expect(result).toContain('## Registered Tools')
        expect(result).not.toContain('---bash---')
        expect(result).not.toContain('## Bash Commands')
        expect(result).toContain('Example: `Read README.md`')
    })

    test("buildToolAwareSystemPrompt shares the tool surface and bash section", () => {
        const result = buildToolAwareSystemPrompt("Base prompt", tools, {
            bashAvailable: true,
            backgroundBashAvailable: true,
        })

        expect(result).toContain("Base prompt")
        expect(result).toContain("## Available Tools")
        expect(result).toContain('## Registered Tools')
        expect(result).toContain("Read <path>")
        expect(result).toContain('Example: `Read README.md`')
        expect(result).toContain('## Bash Commands')
        expect(result).toContain('## Background Bash Commands')
        expect(result).toContain(BACKGROUND_BASH_START_EXAMPLE_LINE)
    })

    test("buildToolAwareSystemPrompt keeps the base prompt when no tools are available", () => {
        const result = buildToolAwareSystemPrompt("Base prompt", [])

        expect(result).toBe("Base prompt")
    })

    test("shared tool usage rule forbids invented tools and wrapper flags", () => {
        expect(SHARED_TOOL_USAGE_RULE).toContain("Use only the tools that are actually listed in the tool section.")
        expect(SHARED_TOOL_USAGE_RULE).toContain("Do not invent tools, parameters, wrapper flags, bare assignment-style arguments, or capabilities that are not explicitly listed.")
        expect(SHARED_TOOL_USAGE_RULE).toContain("Follow each tool's description, usage surface, and parameter schema exactly.")
    })

    test("buildAgentIdentityLine returns the shared identity line", () => {
        expect(buildAgentIdentityLine({
            agentName: "Monospace",
            roleDescription: "research and systems-design",
        })).toBe("You are Monospace, a research and systems-design agent.")
    })

    test("buildWebRuntimeRules centralizes shared web runtime recovery rules", () => {
        const rules = buildWebRuntimeRules({
            includeVerifiedCompletionRule: true,
            additionalRules: [
                "Do not claim success until the observed tool state shows the requested change is complete.",
                "Return concise answers.",
            ],
        })

        expect(rules).toContain("Treat the structured control headers as reserved control syntax")
        expect(rules).toContain("If the previous response was rejected for format")
        expect(rules).toContain("Do not claim success until your latest tool results or observed state show the task is complete.")
        expect(rules).toContain("Do not claim success until the observed tool state shows the requested change is complete.")
        expect(rules).toContain("Return concise answers.")
        expect(rules).not.toContain(SHARED_TOOL_USAGE_RULE)
    })

    test("buildAgentSystemPrompt builds the shared web prompt surface", () => {
        const result = buildAgentSystemPrompt({
            identityLine: "You are TestAgent, a web execution agent.",
            tools,
            bashAvailable: true,
            backgroundBashAvailable: true,
            supplementalRules: buildWebRuntimeRules({
                additionalRules: ["Return concise answers."],
            }),
        })

        expect(result).toContain("You are TestAgent, a web execution agent.")
        expect(result).toContain("# TOOLS")
        expect(result).toContain("Read <path>")
        expect(result).toContain("Return concise answers.")
        expect(result).toContain('## Background Bash Commands')
    })

    test("buildAgentSystemPrompt lets customizers append to the tools section", () => {
        const result = buildAgentSystemPrompt({
            identityLine: "You are TestAgent, a web execution agent.",
            tools,
            bashAvailable: true,
            systemPromptCustomizers: [
                createAppendToolsSectionCustomizer("Custom warning block"),
            ],
        })

        expect(result).toContain("Custom warning block")
        expect(result.indexOf("Custom warning block")).toBeGreaterThan(
            result.indexOf('## Bash Commands'),
        )
    })

    test("buildAgentSystemPrompt lets customizers replace the tool section surface", () => {
        const result = buildAgentSystemPrompt({
            identityLine: "You are TestAgent, a web execution agent.",
            tools,
            bashAvailable: true,
            systemPromptCustomizers: [
                createToolsSectionOverrideCustomizer((context) =>
                    formatToolsSection(context.tools, {
                        ...context.toolsSectionOptions,
                        bashCommandsSectionOptions: {
                            additionalGuidanceLines:
                                JUST_BASH_SCRIPT_EXECUTION_RESTRICTION_LINES,
                            shellNativeWorkflowCommandExamples:
                                JUST_BASH_SHELL_NATIVE_WORKFLOW_COMMAND_EXAMPLES,
                        },
                    }),
                ),
            ],
        })

        expect(result).toContain(JUST_BASH_SHELL_NATIVE_WORKFLOW_COMMAND_EXAMPLES)
        expect(result).toContain(JUST_BASH_SCRIPT_EXECUTION_RESTRICTION_LINES[0])
        expect(result).not.toContain(SHELL_NATIVE_WORKFLOW_COMMAND_EXAMPLES)
    })

    test("buildValidationRecoveryRuleLines returns shared recovery guidance", () => {
        const rules = buildValidationRecoveryRuleLines({
            includeVerifiedCompletionRule: true,
        })

        expect(rules).toContain("If the previous response was rejected for format, do not explain the response protocol back to the system.")
        expect(rules).toContain("Recover by choosing one concrete next action.")
        expect(rules).toContain("Treat the structured control headers as reserved control syntax and use them only in the final executable segment.")
        expect(rules).toContain("The slug header is a hard separator between prose/thought and command/action. Put all prose before the slug, put the standalone slug header on its own line, and put only the executable payload on the following line(s). There must be a newline before the slug header and a newline after the slug header.")
        expect(rules).toContain('Correct example: prose first, then one slug header, then one executable payload block.')
        expect(rules).toContain('Correct example:\n---bash---\nls -la')
        expect(rules).toContain('Correct finish example:\nTask complete.\n---bash---\nexit 0')
        expect(rules).toContain('Correct tool example:\nI\'ll read the create-app skill first.\n---tool---\nReadSkill --skill_name "create-app"')
        expect(rules).toContain('Incorrect example:\n---bash--- ls -la ---bash---')
        expect(rules).toContain('Incorrect example:\n---bash--- ls -la ---tool--- BraveWebSearch "hello world"')
        expect(rules).toContain('Incorrect example:\nTask complete. ---bash--- exit 0')
        expect(rules).toContain('Incorrect example:\nI\'ll build a landing page for Monako Glass smart glasses. Let me first read the create-app skill to ensure I scaffold this project correctly. ---tool--- ReadSkill --skill_name "create-app"')
        expect(rules).toContain('Incorrect example:\n---tool--- ReadSkill --skill_name "create-app"')
        expect(rules).toContain("Do not claim success until your latest tool results or observed state show the task is complete.")
        expect(DEFAULT_AGENT_FALLBACK_SYSTEM_PROMPT).toBe("You are an AI agent.")
    })

    test("shared prompt helpers format indented recovery rules", () => {
        const validationBlock = buildValidationRecoveryRuleLines({
            includeVerifiedCompletionRule: true,
        }).map((rule) => `    - ${rule}`).join("\n")

        expect(validationBlock).toContain("    - Recover by choosing one concrete next action.")
    })

    test("buildCoreStaticRules keeps tool-call guidance and drops deprecated progress rules", () => {
        const rules = buildCoreStaticRules()
        const deprecatedUpdateCommand = ["mile", "stone_update"].join("")

        expect(rules).toContain('Use a final ---bash--- control block whose payload is exit 0 only when finishing successfully, and a final ---bash--- control block whose payload is exit 1 only when finishing unsuccessfully.')
        expect(rules).toContain('Respond with normal prose first, then end every response with exactly one structured control block whose standalone slug header is on its own line and whose payload is on the following line(s):')
        expect(rules).toContain('Treat the structured control headers as reserved control syntax')
        expect(rules).toContain('The slug header is a hard separator between prose/thought and command/action. Put all prose before the slug, put the standalone slug header on its own line, and put only the executable payload on the following line(s). There must be a newline before the slug header and a newline after the slug header.')
        expect(rules).toContain(SHARED_TOOL_USAGE_RULE)
        expect(rules).toContain('Never mention, quote, or explain the control headers in your analysis, summaries, or self-corrections')
        expect(rules).not.toContain("## Scratchpad")
        expect(rules).toContain('---tool---\nExactToolName --required-flag "value"')
        expect(rules).toContain('---tool---\nexacttoolname required-arg')
        expect(rules).toContain('---tool---\nExactToolName required_flag="value"')
        expect(rules).toContain('Correct separator example:')
        expect(rules).toContain('Task complete.\n---bash---\nexit 0')
        expect(rules).toContain('I\'ll read the create-app skill first.\n---tool---\nReadSkill --skill_name "create-app"')
        expect(rules).toContain('---bash--- ls -la ---bash---')
        expect(rules).toContain('---bash--- ls -la ---tool--- BraveWebSearch "hello world"')
        expect(rules).toContain('Task complete. ---bash--- exit 0')
        expect(rules).toContain('I\'ll build a landing page for Monako Glass smart glasses. Let me first read the create-app skill to ensure I scaffold this project correctly. ---tool--- ReadSkill --skill_name "create-app"')
        expect(rules).toContain('---tool--- ReadSkill --skill_name "create-app"')
        expect(rules).not.toContain("follow the exact CLI usage shown in the tool section, including positional arguments, flag usage, passthrough behavior, and assignment-style restrictions")
        expect(rules).not.toContain("--flag=value")
        expect(rules).toContain('The final control block is ALWAYS the very last thing in the response')
        expect(rules).not.toContain("BraveWebSearch <query>")
        expect(rules).not.toContain("Curl --args")
        expect(rules).not.toContain("pencil-design")
        expect(rules).not.toContain("- Multiple:")
        expect(rules).not.toContain(deprecatedUpdateCommand)
    })

    test("buildWorkspaceCodingStaticRules adds shared coding-agent guidance", () => {
        const rules = buildWorkspaceCodingStaticRules({
            additionalRuleSections: [
                {
                    heading: "Repo Preferences",
                    ruleLines: ["Prefer focused, source-backed research when using search tools."],
                },
            ],
        })

        expect(rules).toContain("WORKSPACE CODING AGENT RULES")
        expect(rules).toContain("READ BEFORE WRITE")
        expect(rules).toContain("CREATE PARENTS BEFORE CAT")
        expect(rules).toContain("SKILL-FIRST WORKFLOWS")
        expect(rules).toContain("TARGETED EDITS")
        expect(rules).toContain("EXPLORE, PLAN, THEN IMPLEMENT")
        expect(rules).toContain("PORT CONFLICTS")
        expect(rules).toContain("RELATIVE PATHS")
        expect(rules).toContain("Prefer focused, source-backed research when using search tools.")
        expect(rules).toContain("## Verification")
        expect(rules).toContain("## Efficiency")
        expect(rules).toContain("always use narrow search-and-replace or patch-style edits")
        expect(rules).toContain("SEARCH/REPLACE REQUIRED")
        expect(rules).toContain("Never regenerate or overwrite an existing file with `cat > file <<'EOF'`")
        expect(rules).toContain("For ambiguous, multi-file, or unfamiliar work: explore first, form a plan, then implement.")
        expect(rules).toContain("Fix root causes rather than suppressing symptoms.")
        expect(rules).toContain("prefer a complete validated file or a sequence of coherent patch-sized edits")
        expect(rules).toContain(`Use bash with ${WORKSPACE_CONTEXT_GATHERING_COMMAND_EXAMPLES} to discover structure, inspect related files, and understand patterns before changing code.`)
        expect(rules).toContain(`Use bash with ${WORKSPACE_CONTEXT_GATHERING_COMMAND_EXAMPLES} to locate files and inspect focused ranges instead of repeatedly dumping whole files.`)
        expect(rules).toContain(SHALLOW_WORKSPACE_DISCOVERY_RULE_LINE)
        expect(rules).toContain("always run `mkdir -p path/to` first")
        expect(rules).toContain("## Repo Preferences")
        expect(rules).not.toContain("VALIDATION RECOVERY")
        expect(rules).not.toContain("TOOL INVOCATION SCOPE")
        expect(rules).not.toContain("DOWNLOADED IMAGES")
    })

    test("buildWorkspaceCodingStaticRules can include agent-specific editing preferences in the editing strategy section", () => {
        const extraEditingPreference = "Prefer verified patch-sized edits over whole-file rewrites."
        const rules = buildWorkspaceCodingStaticRules({
            additionalRuleSections: [
                {
                    section: "editing-strategy",
                    ruleLines: [extraEditingPreference],
                },
            ],
        })

        expect(rules).toContain(extraEditingPreference)
        expect(rules).toContain("TARGETED EDITS")
        expect(rules).toContain("EXPLORE, PLAN, THEN IMPLEMENT")
        expect(rules).toContain("READ BEFORE WRITE")
        expect(rules).toContain("CREATE PARENTS BEFORE CAT")
        expect(rules).not.toContain("## Repo Preferences")
    })

    test("buildWorkspaceCodingStaticRules can omit the shared port conflict hint", () => {
        const rules = buildWorkspaceCodingStaticRules({
            additionalRuleSections: [
                {
                    section: "efficiency",
                    omitRuleLines: [PORT_CONFLICT_RULE_LINE],
                },
            ],
        })

        expect(rules).not.toContain("PORT CONFLICTS")
        expect(rules).toContain("## Efficiency")
    })

    test("buildWorkspaceCodingStaticRules can omit runtime-dependent verification rules", () => {
        const rules = buildWorkspaceCodingStaticRules({
            additionalRuleSections: [
                {
                    section: "verification",
                    omitRuleLines: [
                        INCREMENTAL_TESTING_RULE_LINE,
                        CODE_QUALITY_RULE_LINE,
                    ],
                    ruleLines: [
                        "**LIMITED EXECUTION**: Verify with available tools and inspection when the backend cannot run project runtimes.",
                    ],
                },
            ],
        })

        expect(rules).toContain("## Verification")
        expect(rules).not.toContain(INCREMENTAL_TESTING_RULE_LINE)
        expect(rules).not.toContain(CODE_QUALITY_RULE_LINE)
        expect(rules).toContain("**LIMITED EXECUTION**: Verify with available tools and inspection when the backend cannot run project runtimes.")
    })

    test("buildWorkspaceCodingStaticRules ignores empty additional sections", () => {
        const rules = buildWorkspaceCodingStaticRules({
            additionalRuleSections: [
                {
                    heading: "Repo Preferences",
                    ruleLines: ["Prefer focused, source-backed research when using search tools."],
                },
                {
                    heading: "   ",
                    ruleLines: ["This should not render."],
                },
                {
                    heading: "Unused Section",
                    ruleLines: ["   ", ""],
                },
            ],
        })

        expect(rules).toContain("## Repo Preferences")
        expect(rules).toContain("Prefer focused, source-backed research when using search tools.")
        expect(rules).not.toContain("This should not render.")
        expect(rules).not.toContain("## Unused Section")
    })

    test("buildWorkspaceCodingStaticRules can target a built-in section and remove specific rule lines", () => {
        const rules = buildWorkspaceCodingStaticRules({
            additionalRuleSections: [
                {
                    section: "efficiency",
                    omitRuleLines: [PORT_CONFLICT_RULE_LINE],
                    ruleLines: ["**EXTRA EFFICIENCY**: Prefer validated patch-sized changes over oversized rewrites."],
                },
            ],
        })

        expect(rules).toContain("## Efficiency")
        expect(rules).toContain("**EXTRA EFFICIENCY**: Prefer validated patch-sized changes over oversized rewrites.")
        expect(rules).not.toContain("PORT CONFLICTS")
    })

    test("buildAgentSystemPrompt produces a workspace-coding prompt without task text or action counters", () => {
        const result = buildAgentSystemPrompt({
            tools,
            identityLine: "You are Monospace, a research and systems-design agent.",
            bashAvailable: true,
        })

        expect(result).not.toContain('Task: "Build app"')
        expect(result).not.toContain("ACTION #2")
        expect(result).toContain("# TOOLS")
        expect(result).toContain('## Bash Commands')
    })

    test("buildSkillAwareStaticContext sorts skill summaries and omits the loaded count", () => {
        const context = buildSkillAwareStaticContext({
            allSkills: [
                { metadata: { name: "zeta-skill", description: "Later alphabetically" } },
                { metadata: { name: "canvas-design", description: "Structured canvas workflow" } },
            ],
            staticRules: "STATIC RULES",
        })

        expect(context).toContain("AVAILABLE SKILLS")
        expect(context).toContain("canvas-design")
        expect(context.indexOf("canvas-design")).toBeLessThan(context.indexOf("zeta-skill"))
        expect(context).not.toContain("loaded)")
        expect(context).toContain("If a listed skill clearly matches the task, prefer reading that skill before planning or implementing a generic approach")
        expect(context).toContain("Prefer the most specific relevant skill over a broader fallback skill when multiple skills could apply")
        expect(context).toContain(SKILL_INVOKE_READ_RULE_LINE)
        expect(context).toContain("If a skill you read instructs you to consult another foundational skill, follow that dependency before implementation")
        expect(context).toContain("STATIC RULES")
    })

    test("buildStepUserMessage omits the action counter", () => {
        const message = buildStepUserMessage({ actionCount: 2 })

        expect(message).not.toContain("Action 2")
        expect(message).toContain("Continue working on the task")
    })

    test("extractTruncatedToolInfo parses write-tool hints", () => {
        const info = extractTruncatedToolInfo([
            {
                name: "Write",
                parameters: {
                    path: "src/app.ts",
                },
            },
        ])

        expect(info).toEqual({
            name: "Write",
            filePath: "src/app.ts",
            executionSucceeded: false,
        })
    })
})
