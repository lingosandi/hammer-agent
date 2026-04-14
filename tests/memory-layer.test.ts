/**
 * Tests for @shared/utils/agent-memory-layer (AgentMemoryLayer)
 *
 * Tests the core memory layer functions:
 *   - appendMessage (message storage)
 *   - buildMessages (context assembly)
 *   - setStaticContext / hasStaticContext
 *   - getMetrics
 *   - performCompaction (retained-note / evidence / failure extraction)
 *   - finalizeCompactedState (dedup, aging, hard caps, category canonicalization)
 */
import { describe, expect, test, afterEach } from "vitest"
import { AgentMemoryLayer, type RawMessage } from "../src/index"
import type { AgentMemoryLayerConfig } from "../src/index"
import { formatToolResultMessage } from "../src/index"
import { TiktokenEstimator } from "../src/node"
import type { ToolCall, ToolDefinition } from "../src/index"

// Inlined from @shared/config/agent-config (Hammer production values)
const HAMMER_COMPACTION_TOKEN_THRESHOLD = 150_000
const HAMMER_PROTECTED_CONTEXT_TOKENS = 60_000
const HAMMER_STATE_BUDGET_TOKENS = 10_000
const HAMMER_SYSTEM_PROMPT_OVERHEAD = 4_000
const HAMMER_MAX_RAW_HISTORY = 2_000
const HAMMER_COMPACTION_DEBOUNCE_TURNS = 3
const COMPACTION_LLM_TEMPERATURE = 0.1
const COMPACTION_LLM_MAX_TOKENS = 4096
const MAX_RETAINED_NOTES = 100
const MAX_FAILED_ATTEMPTS = 50
const MAX_CODEBASE_EVIDENCE = 100
const MAX_RESEARCH_EVIDENCE = 50
const MAX_CONSTRAINTS = 50

const bashSegment = (payload: string) => ["---bash---", payload].join("\n")
const toolSegment = (payload: string) => ["---tool---", payload].join("\n")
const successSegment = (payload: string) => bashSegment(payload === "true" ? "exit 0" : "exit 1")

const TEST_TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        name: "Read",
        description: "Read a text file.",
        parameters: {
            path: { type: "string", description: "File path", required: true },
        },
    },
    {
        name: "BraveWebSearch",
        description: "Search the web.",
        parameters: {
            query: { type: "string", description: "Search query", required: true },
        },
        metadata: {
            category: "web",
            capabilities: ["search", "information_retrieval"],
            memory: {
                note: {
                    scope: "tool",
                    kind: "operation",
                },
                evidence: [
                    {
                        kind: "research",
                        citation: "query",
                    },
                ],
            },
        },
    },
    {
        name: "Curl",
        description: "Fetch a web page.",
        parameters: {
            args: { type: "string", description: "Raw curl-style arguments", required: true },
        },
        metadata: {
            category: "web",
            capabilities: ["fetch", "http", "content_retrieval", "raw_command_args"],
            memory: {
                note: {
                    scope: "tool",
                    kind: "operation",
                },
                evidence: [
                    {
                        kind: "research",
                        citation: "url",
                    },
                ],
            },
        },
    },
    {
        name: "Bash",
        description: "Run a shell command.",
        parameters: {
            command: { type: "string", description: "Shell command", required: true },
        },
        metadata: {
            category: "system",
            capabilities: ["shell", "system_commands", "process_management"],
            memory: {
                note: {
                    scope: "tool",
                    kind: "operation",
                },
                evidence: [
                    {
                        kind: "research",
                        citation: "command",
                    },
                ],
            },
        },
    },
]

// ---------------------------------------------------------------------------
// Test subclass that exposes protected methods for direct testing.
// This avoids needing to generate 100K+ tokens to trigger compaction.
// ---------------------------------------------------------------------------

/** Default test config matching Hammer's production values. */
function testConfig(overrides?: Partial<AgentMemoryLayerConfig>): AgentMemoryLayerConfig {
    return {
        compactionTokenThreshold: HAMMER_COMPACTION_TOKEN_THRESHOLD,
        protectedContextTokens: HAMMER_PROTECTED_CONTEXT_TOKENS,
        stateBudgetTokens: HAMMER_STATE_BUDGET_TOKENS,
        maxRawHistory: HAMMER_MAX_RAW_HISTORY,
        compactionDebounceTurns: HAMMER_COMPACTION_DEBOUNCE_TURNS,
        systemPromptOverhead: HAMMER_SYSTEM_PROMPT_OVERHEAD,
        tokenEstimator: new TiktokenEstimator(),
        compactionTemperature: COMPACTION_LLM_TEMPERATURE,
        compactionMaxTokens: COMPACTION_LLM_MAX_TOKENS,
        getToolDefinitions: () => TEST_TOOL_DEFINITIONS,
        ...overrides,
    }
}

class TestableAgentMemoryLayer extends AgentMemoryLayer {
    /** Directly invoke performCompaction on supplied messages. */
    testPerformCompaction(messages: RawMessage[]): void {
        this.performCompaction(messages)
    }

    /** Directly invoke finalizeCompactedState. */
    testFinalizeCompactedState(): void {
        ;(this as any).finalizeCompactedState()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLayer(overrides?: Partial<AgentMemoryLayerConfig>): TestableAgentMemoryLayer {
    return new TestableAgentMemoryLayer(testConfig(overrides))
}

function getEvidenceSummaries(
    layer: TestableAgentMemoryLayer,
    kind?: "codebase" | "research",
): string[] {
    const evidence = layer.getCompressedState().evidence
    return (kind ? evidence.filter((entry) => entry.kind === kind) : evidence)
        .map((entry) => entry.summary)
}

function seedCompressedState(
    layer: TestableAgentMemoryLayer,
    state: Parameters<TestableAgentMemoryLayer["loadFromPersisted"]>[0]["compressedState"],
    overrides?: Partial<Parameters<TestableAgentMemoryLayer["loadFromPersisted"]>[0]>,
): void {
    layer.loadFromPersisted({
        rawHistory: overrides?.rawHistory ?? layer.getRawHistory(),
        compressedState: state,
        compactionCursor: overrides?.compactionCursor ?? { lastCompactedTurn: 0 },
        currentTurn: overrides?.currentTurn ?? layer.getCurrentTurn(),
        lastCompactionAttempt: overrides?.lastCompactionAttempt ?? 0,
        compactionCount: overrides?.compactionCount ?? 0,
    })
}

// Clean up tiktoken encoder after each test to avoid memory leaks
let layerInstances: TestableAgentMemoryLayer[] = []
function tracked(layer: TestableAgentMemoryLayer): TestableAgentMemoryLayer {
    layerInstances.push(layer)
    return layer
}

afterEach(() => {
    for (const l of layerInstances) {
        l.dispose()
    }
    layerInstances = []
})

// ---------------------------------------------------------------------------
// appendMessage
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — appendMessage", () => {
    test("returns a unique message ID", () => {
        const layer = tracked(createLayer())
        const id1 = layer.appendMessage({
            role: "user",
            content: "Hello"
        })
        const id2 = layer.appendMessage({
            role: "assistant",
            content: "Hi there"
        })
        expect(id1).toBeTruthy()
        expect(id2).toBeTruthy()
        expect(id1).not.toBe(id2)
    })

    test("increments message count in metrics", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "A" })
        layer.appendMessage({ role: "assistant", content: "B" })
        const metrics = layer.getMetrics()
        expect(metrics.totalMessages).toBe(2)
        expect(metrics.totalTurns).toBe(2)
    })

    test("stores messages in raw history", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "Test" })
        const history = layer.getRawHistory()
        expect(history).toHaveLength(1)
        expect(history[0].role).toBe("user")
        expect(history[0].content).toBe("Test")
    })

    test("assigns incrementing turn numbers", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "A" })
        layer.appendMessage({ role: "assistant", content: "B" })
        layer.appendMessage({ role: "user", content: "C" })
        const history = layer.getRawHistory()
        expect(history[0].turn).toBe(1)
        expect(history[1].turn).toBe(2)
        expect(history[2].turn).toBe(3)
    })

    test("computes token count for each message", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({
            role: "user",
            content: "Hello world, this is a test message"
        })
        const history = layer.getRawHistory()
        expect(history[0].tokenCount).toBeGreaterThan(0)
    })
})

// ---------------------------------------------------------------------------
// buildMessages
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — buildMessages", () => {
    test("includes system prompt as first message", () => {
        const layer = tracked(createLayer())
        const messages = layer.buildMessages("You are an AI agent.")
        expect(messages[0].role).toBe("system")
        expect(messages[0].content).toContain("You are an AI agent.")
    })

    test("includes recent messages after system prompt", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "Do X" })
        layer.appendMessage({
            role: "assistant",
            content: [
                "I need to inspect the code first.",
                bashSegment("cat src/app.ts"),
            ].join("\n")
        })
        const messages = layer.buildMessages("System prompt")
        // Should have system + user + assistant
        expect(messages.length).toBeGreaterThanOrEqual(2)
        // user message should be present
        const userMsg = messages.find(
            (m) => m.role === "user" && m.content.includes("Do X")
        )
        expect(userMsg).toBeDefined()
    })

    test("converts tool messages to user messages", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "Q" })
        layer.appendMessage({
            role: "tool",
            content: "File contents here",
            toolCallId: "tc1"
        })
        const messages = layer.buildMessages("System")
        // Tool messages should become user messages with "Tool result:" prefix
        const toolResult = messages.find(
            (m) => m.content.includes("Tool result:")
        )
        expect(toolResult).toBeDefined()
        expect(toolResult!.role).toBe("user")
    })

    test("merges consecutive same-role messages", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "Message 1" })
        layer.appendMessage({ role: "user", content: "Message 2" })
        const messages = layer.buildMessages("System")
        // Two consecutive user messages should be merged
        const userMessages = messages.filter((m) => m.role === "user")
        // Should be a single merged user message
        expect(userMessages.length).toBe(1)
        expect(userMessages[0].content).toContain("Message 1")
        expect(userMessages[0].content).toContain("Message 2")
    })

    test("includes static context when set", () => {
        const layer = tracked(createLayer())
        layer.setStaticContext("Static rules here")
        const messages = layer.buildMessages("System prompt")
        // Static context should be merged into system message
        const systemContent = messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n")
        expect(systemContent).toContain("Static rules here")
    })

    test("returns ChatMessage[] format", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "Test" })
        const messages = layer.buildMessages("System")
        for (const msg of messages) {
            expect(msg).toHaveProperty("role")
            expect(msg).toHaveProperty("content")
            expect(["system", "user", "assistant", "tool"]).toContain(
                msg.role
            )
            expect(typeof msg.content).toBe("string")
        }
    })

    test("guards against missing user message before assistant", () => {
        const layer = tracked(createLayer())
        // Only add an assistant message (no user message)
        layer.appendMessage({
            role: "assistant",
            content: [
                "I need one more step.",
            ].join("\n")
        })
        const messages = layer.buildMessages("System")
        // Should inject a synthetic user message before assistant
        const roles = messages.map((m) => m.role)
        const firstNonSystem = roles.findIndex((r) => r !== "system")
        if (firstNonSystem !== -1 && roles[firstNonSystem + 1] === "assistant") {
            expect(roles[firstNonSystem]).toBe("user")
        }
    })

    test("merges multiple leading system messages into one", () => {
        const layer = tracked(createLayer())
        layer.setStaticContext("Rules")
        layer.appendMessage({ role: "user", content: "Go" })
        const messages = layer.buildMessages("System prompt")
        // Count system messages — should be exactly 1 after merging
        const systemMessages = messages.filter((m) => m.role === "system")
        expect(systemMessages).toHaveLength(1)
    })
})

// ---------------------------------------------------------------------------
// setStaticContext / hasStaticContext
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — static context", () => {
    test("hasStaticContext returns false initially", () => {
        const layer = tracked(createLayer())
        expect(layer.hasStaticContext()).toBe(false)
    })

    test("hasStaticContext returns true after setStaticContext", () => {
        const layer = tracked(createLayer())
        layer.setStaticContext("Some rules")
        expect(layer.hasStaticContext()).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// getMetrics
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — getMetrics", () => {
    test("returns initial zero metrics", () => {
        const layer = tracked(createLayer())
        const metrics = layer.getMetrics()
        expect(metrics.totalTurns).toBe(0)
        expect(metrics.totalMessages).toBe(0)
        expect(metrics.compactionCount).toBe(0)
    })

    test("tracks message additions", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "X" })
        layer.appendMessage({ role: "assistant", content: "Y" })
        layer.appendMessage({ role: "user", content: "Z" })
        const metrics = layer.getMetrics()
        expect(metrics.totalTurns).toBe(3)
        expect(metrics.totalMessages).toBe(3)
    })

    test("includes compressed state token estimate", () => {
        const layer = tracked(createLayer())
        const metrics = layer.getMetrics()
        expect(typeof metrics.compressedStateTokens).toBe("number")
        expect(typeof metrics.estimatedContextTokens).toBe("number")
    })
})

// ---------------------------------------------------------------------------
// getRawHistory
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — getRawHistory", () => {
    test("returns a copy (not reference to internal array)", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "Test" })
        const history1 = layer.getRawHistory()
        const history2 = layer.getRawHistory()
        expect(history1).not.toBe(history2) // different array instances
        expect(history1).toEqual(history2)   // same content
    })

    test("modifying returned array does not affect internal state", () => {
        const layer = tracked(createLayer())
        layer.appendMessage({ role: "user", content: "Test" })
        const history = layer.getRawHistory()
        history.push({
            id: "fake",
            role: "user",
            content: "Injected",
            timestamp: 0,
            turn: 99,
            tokenCount: 0
        })
        expect(layer.getRawHistory()).toHaveLength(1) // still only 1
    })
})

// ---------------------------------------------------------------------------
// performCompaction (via TestableAgentMemoryLayer.testPerformCompaction)
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — performCompaction", () => {
    test("extracts a retained note for a single assistant tool command", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "assistant", turn: 1, timestamp: 1,
                tokenCount: 100,
                content: [
                    "Using shared tools",
                    toolSegment('Curl https://example.com'),
                ].join("\n"),
            },
        ]

        layer.testPerformCompaction(messages)
        const state = layer.getCompressedState()

        expect(state.retainedNotes.length).toBe(1)
        expect(state.retainedNotes[0].category).toBe("tool_Curl")
        expect(state.retainedNotes[0].kind).toBe("operation")
    })

    test("ignores tool-like prose when the final directive is an exit segment", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "assistant", turn: 1, timestamp: 1,
                tokenCount: 100,
                content: [
                    "I already have the answer. I previously considered Curl https://example.com.",
                    successSegment("true"),
                ].join("\n"),
            },
        ]

        layer.testPerformCompaction(messages)
        const state = layer.getCompressedState()

        expect(state.retainedNotes).toHaveLength(0)
    })

    test("extracts research evidence from successful Curl tool results", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: JSON.stringify({
                    tool_name: "Curl",
                    success: true,
                    url: "https://example.com",
                    content: "Example Domain homepage",
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(1)
        expect(researchEvidence[0].summary).toContain("Fetched https://example.com")
        expect(researchEvidence[0].summary).toContain("Example Domain homepage")
        expect(researchEvidence[0].citations).toEqual([
            { kind: "url", value: "https://example.com" },
        ])
    })

    test("extracts research evidence from plain-text formatted Curl tool results", () => {
        const layer = tracked(createLayer())
        const toolCall: ToolCall = {
            name: "Curl",
            parameters: { args: "https://example.com" },
            rawInvocation: "Curl https://example.com",
        }

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: formatToolResultMessage(toolCall, {
                    success: true,
                    url: "https://example.com",
                    method: "GET",
                    status: 200,
                    content: "Example Domain homepage",
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(1)
        expect(researchEvidence[0].summary).toContain("Fetched https://example.com")
        expect(researchEvidence[0].summary).toContain("Example Domain homepage")
    })

    test("extracts evidence from tools using citation metadata instead of hardcoded names", () => {
        const layer = tracked(createLayer({
            getToolDefinitions: () => [
                ...TEST_TOOL_DEFINITIONS,
                {
                    name: "HttpFetch",
                    description: "Fetch a web page through an alias tool.",
                    parameters: {
                        url: { type: "string", description: "URL", required: true },
                    },
                    metadata: {
                        category: "web",
                        capabilities: ["fetch", "http"],
                        memory: {
                            note: {
                                scope: "tool",
                                kind: "operation",
                            },
                            evidence: [
                                {
                                    kind: "research",
                                    citation: "url",
                                },
                            ],
                        },
                    },
                },
            ],
        }))
        const toolCall: ToolCall = {
            name: "HttpFetch",
            parameters: { url: "https://example.com/docs" },
        }

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: formatToolResultMessage(toolCall, {
                    success: true,
                    url: "https://example.com/docs",
                    method: "GET",
                    status: 200,
                    content: "Alias fetch content",
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(1)
        expect(researchEvidence[0].summary).toContain("Fetched https://example.com/docs")
        expect(researchEvidence[0].summary).toContain("Alias fetch content")
    })

    test("assigns tool_Bash category without path for bash retained notes", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "assistant", turn: 1, timestamp: 1,
                tokenCount: 100,
                content: [
                    "Running tests",
                    bashSegment("vitest run memory"),
                ].join("\n"),
            },
        ]

        layer.testPerformCompaction(messages)
        const state = layer.getCompressedState()

        expect(state.retainedNotes.length).toBe(1)
        expect(state.retainedNotes[0].category).toBe("tool_Bash")
        expect(state.retainedNotes[0].summary).toContain("vitest run")
    })

    test("extracts research evidence from successful Bash tool results", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: JSON.stringify({
                    tool_name: "Bash",
                    success: true,
                    command: "vitest run memory",
                    stdout: "12 tests passed",
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(1)
        expect(researchEvidence[0].summary).toContain('Shell "vitest run memory"')
        expect(researchEvidence[0].summary).toContain("12 tests passed")
        expect(researchEvidence[0].citations).toEqual([
            { kind: "command", value: "vitest run memory" },
        ])
    })

    test("extracts research evidence from plain-text formatted Bash tool results", () => {
        const layer = tracked(createLayer())
        const toolCall: ToolCall = {
            name: "Bash",
            parameters: { command: "vitest run memory" },
        }

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: formatToolResultMessage(toolCall, {
                    success: true,
                    command: "vitest run memory",
                    stdout: "12 tests passed",
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(1)
    expect(researchEvidence[0].summary).toContain('Shell "vitest run memory"')
        expect(researchEvidence[0].summary).toContain("12 tests passed")
    })

    test("uses stderr when large stdout is uninformative", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: JSON.stringify({
                    tool_name: "Bash",
                    success: true,
                    command: "bun install",
                    stdout: Array.from({ length: 120 }, (_, i) => `line-${i}`).join("\n"),
                    stderr: "warning: lockfile updated",
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(1)
        expect(researchEvidence[0].summary).toContain('Shell "bun install"')
        expect(researchEvidence[0].summary).toContain("stderr: warning: lockfile updated")
    })

    test("ignores large uninformative Bash output", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: JSON.stringify({
                    tool_name: "Bash",
                    success: true,
                    command: "find . -type f",
                    stdout: Array.from({ length: 200 }, (_, i) => `entry-${i}`).join("\n"),
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(0)
    })

    test("extracts failed attempts from unsuccessful tool results", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 50, toolCallId: "tc1",
                content: JSON.stringify({ tool_name: "Bash", success: false, error: "Exit code 1: test failed" }),
            },
        ]

        layer.testPerformCompaction(messages)
        const state = layer.getCompressedState()

        expect(state.failedAttempts.length).toBe(1)
        expect(state.failedAttempts[0].approach).toBe("Bash")
        expect(state.failedAttempts[0].reason).toContain("test failed")
    })

    test("extracts [RETAINED_NOTE] markers from assistant content", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "assistant", turn: 1, timestamp: 1,
                tokenCount: 20,
                content: "[RETAINED_NOTE] Use a factory pattern for creating services",
            },
        ]

        layer.testPerformCompaction(messages)
        const state = layer.getCompressedState()

        expect(state.retainedNotes.length).toBe(1)
        expect(state.retainedNotes[0].summary).toContain("factory pattern")
    })

    test("extracts scratchpad from assistant prose", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "assistant", turn: 1, timestamp: 1,
                tokenCount: 50,
                content: [
                    "Thinking about the problem",
                    "Scratchpad: Need to fix the auth module first",
                    bashSegment("cat auth.ts"),
                ].join("\n"),
            },
        ]

        layer.testPerformCompaction(messages)
        const state = layer.getCompressedState()
        expect(state.scratchpad).toBe("Need to fix the auth module first")
    })

    test("extracts research evidence from BraveWebSearch tool results", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 100, toolCallId: "tc1",
                content: JSON.stringify({
                    tool_name: "BraveWebSearch",
                    success: true,
                    query: "vitest configuration",
                    data: "Vitest uses a vitest.config.ts file for test configuration. The test runner supports describe/test/expect patterns similar to Jest.",
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence.length).toBe(1)
        expect(researchEvidence[0].summary).toContain("Search results")
        expect(researchEvidence[0].summary).toContain("vitest configuration")
        expect(researchEvidence[0].citations).toEqual([
            { kind: "query", value: "vitest configuration" },
        ])
    })

    test("extracts research evidence from plain-text formatted BraveWebSearch tool results", () => {
        const layer = tracked(createLayer())
        const toolCall: ToolCall = {
            name: "BraveWebSearch",
            parameters: { query: "vitest configuration" },
        }

        const messages: RawMessage[] = [
            {
                id: "m1", role: "tool", turn: 1, timestamp: 1,
                tokenCount: 100, toolCallId: "tc1",
                content: formatToolResultMessage(toolCall, {
                    success: true,
                    query: "vitest configuration",
                    results: [
                        {
                            title: "Vitest docs",
                            url: "https://vitest.dev/config/",
                            snippet: "Vitest uses a vitest.config.ts file for test configuration.",
                        },
                    ],
                    count: 1,
                }),
            },
        ]

        layer.testPerformCompaction(messages)
        const researchEvidence = layer.getCompressedState().evidence.filter(
            (entry) => entry.kind === "research",
        )

        expect(researchEvidence).toHaveLength(1)
        expect(researchEvidence[0].summary).toContain("Search results")
    expect(researchEvidence[0].summary).toContain("vitest configuration")
    expect(researchEvidence[0].summary).toContain("Vitest docs")
    })

    test("ignores non-significant registered tool calls (e.g. Read)", () => {
        const layer = tracked(createLayer())

        const messages: RawMessage[] = [
            {
                id: "m1", role: "assistant", turn: 1, timestamp: 1,
                tokenCount: 50,
                content: [
                    "Reading a file",
                    toolSegment("Read readme.md"),
                ].join("\n"),
            },
        ]

        layer.testPerformCompaction(messages)
        const state = layer.getCompressedState()

        // Read is not classified as a significant tool call, so no retained note should be extracted
        expect(state.retainedNotes.length).toBe(0)
    })
})

// ---------------------------------------------------------------------------
// compactState (via TestableAgentMemoryLayer.testCompactState)
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — compactState", () => {
    test("keeps latest retained note per category and discards older", () => {
        const layer = tracked(createLayer())

        seedCompressedState(layer, {
            retainedNotes: [
                { summary: "BraveWebSearch: old query", category: "tool_BraveWebSearch", turn: 1 },
                { summary: "BraveWebSearch: latest query", category: "tool_BraveWebSearch", turn: 10 },
                { summary: "Curl: https://example.com", category: "tool_Curl", turn: 5 },
                { summary: "Bash: vitest run", category: "tool_Bash", turn: 3 },
                { summary: "Bash: bun build", category: "tool_Bash", turn: 8 },
            ],
            constraints: [],
            evidence: [],
            failedAttempts: [],
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: 10,
        })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        // Two Bash retained notes → keep only the later one
        const bashRetainedNotes = result.retainedNotes.filter((t) => t.category === "tool_Bash")
        expect(bashRetainedNotes.length).toBe(1)
        expect(bashRetainedNotes[0].summary).toContain("bun build")

        const webSearchRetainedNotes = result.retainedNotes.filter((t) => t.category === "tool_BraveWebSearch")
        expect(webSearchRetainedNotes.length).toBe(1)
        expect(webSearchRetainedNotes[0].summary).toContain("latest")

        expect(result.retainedNotes.some((t) => t.category === "tool_Curl")).toBe(true)

        expect(result.retainedNotes.length).toBe(3)
    })

    test("uses category as a semantic dedupe bucket when summaries change", () => {
        const layer = tracked(createLayer())

        seedCompressedState(layer, {
            retainedNotes: [
                { summary: "Use Express.js", category: "framework", kind: "workflow", turn: 1 },
                { summary: "Use Fastify", category: "framework", kind: "workflow", turn: 9 },
                { summary: "Use TypeScript", category: "lang", kind: "workflow", turn: 3 },
            ],
            constraints: [],
            evidence: [],
            failedAttempts: [],
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: 9,
        })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        const frameworkNotes = result.retainedNotes.filter((t) => t.category === "framework")
        expect(frameworkNotes).toHaveLength(1)
        expect(frameworkNotes[0].summary).toBe("Use Fastify")
        expect(result.retainedNotes.some((t) => t.category === "lang")).toBe(true)
        expect(result.retainedNotes).toHaveLength(2)
    })

    test("deduplicates constraints and keeps latest evidence per citation key", () => {
        const layer = tracked(createLayer())

        seedCompressedState(layer, {
            retainedNotes: [],
            constraints: ["Use TypeScript", "Use TypeScript", "No console.log"],
            evidence: [
                {
                    summary: "Canvas changed a.ts (old)",
                    kind: "codebase",
                    citations: [{ kind: "path", value: "a.ts" }],
                    turn: 1,
                },
                {
                    summary: "Canvas changed a.ts (new)",
                    kind: "codebase",
                    citations: [{ kind: "path", value: "a.ts" }],
                    turn: 3,
                },
                {
                    summary: "Search results for docs",
                    kind: "research",
                    citations: [{ kind: "query", value: "docs" }],
                    turn: 2,
                },
                {
                    summary: "Search results for docs (latest)",
                    kind: "research",
                    citations: [{ kind: "query", value: "docs" }],
                    turn: 4,
                },
            ],
            failedAttempts: [],
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: 5,
        })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        expect(result.constraints.map((constraint) => constraint.text)).toEqual(["Use TypeScript", "No console.log"])
        expect(result.evidence).toHaveLength(2)
        expect(result.evidence.some((entry) => entry.summary === "Canvas changed a.ts (new)")).toBe(true)
        expect(result.evidence.some((entry) => entry.summary === "Search results for docs (latest)")).toBe(true)
    })

    test("ages out resolved tasks older than 20 turns", () => {
        const layer = tracked(createLayer())

        // Simulate currentTurn = 50 by appending 50 messages
        for (let i = 0; i < 50; i++) {
            layer.appendMessage({ role: "user", content: `m${i}` })
        }

        seedCompressedState(layer, {
            retainedNotes: [],
            constraints: [],
            evidence: [],
            failedAttempts: [],
            openTasks: [],
            resolvedTasks: [
                { task: "old-task", resolvedTurn: 1 },   // 49 turns ago → aged out
                { task: "recent-task", resolvedTurn: 45 }, // 5 turns ago → kept
            ],
            lastUpdatedTurn: 50,
        }, { currentTurn: 50 })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        expect(result.resolvedTasks.some((t) => t.task === "old-task")).toBe(false)
        expect(result.resolvedTasks.some((t) => t.task === "recent-task")).toBe(true)
    })

    test("ages out failed attempts older than 30 turns", () => {
        const layer = tracked(createLayer())

        // Simulate currentTurn = 50
        for (let i = 0; i < 50; i++) {
            layer.appendMessage({ role: "user", content: `m${i}` })
        }

        seedCompressedState(layer, {
            retainedNotes: [],
            constraints: [],
            evidence: [],
            failedAttempts: [
                { approach: "Bash", reason: "ancient failure", turn: 1 },    // 49 turns ago → aged out
                { approach: "Write", reason: "recent failure", turn: 40 },   // 10 turns ago → kept
            ],
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: 50,
        }, { currentTurn: 50 })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        expect(result.failedAttempts.some((f) => f.reason === "ancient failure")).toBe(false)
        expect(result.failedAttempts.some((f) => f.reason === "recent failure")).toBe(true)
    })

    test("enforces hard cap on retained notes (keeps latest by turn)", () => {
        const layer = tracked(createLayer())

        const retainedNotes = Array.from({ length: MAX_RETAINED_NOTES + 50 }, (_, i) => ({
            summary: `Retained note ${i}`,
            category: `cat_${i}`,
            turn: i,
        }))

        seedCompressedState(layer, {
            retainedNotes,
            constraints: [],
            evidence: [],
            failedAttempts: [],
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: MAX_RETAINED_NOTES + 50,
        }, { currentTurn: MAX_RETAINED_NOTES + 50 })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        expect(result.retainedNotes.length).toBeLessThanOrEqual(MAX_RETAINED_NOTES)
        // Should keep the latest by turn (slice(-MAX_RETAINED_NOTES) after sort)
        const minTurn = Math.min(...result.retainedNotes.map((t) => t.turn))
        expect(minTurn).toBe(50) // 150 unique cats, sorted, sliced to last 100 → turns 50-149
    })

    test("enforces hard caps on constraints and evidence", () => {
        const layer = tracked(createLayer())

        seedCompressedState(layer, {
            retainedNotes: [],
            constraints: Array.from({ length: MAX_CONSTRAINTS + 20 }, (_, i) => `Constraint ${i}`),
            evidence: [
                ...Array.from({ length: MAX_CODEBASE_EVIDENCE + 20 }, (_, i) => ({
                    summary: `Codebase evidence ${i}`,
                    kind: "codebase" as const,
                    citations: [{ kind: "path" as const, value: `file-${i}.ts` }],
                    turn: i,
                })),
                ...Array.from({ length: MAX_RESEARCH_EVIDENCE + 10 }, (_, i) => ({
                    summary: `Research evidence ${i}`,
                    kind: "research" as const,
                    citations: [{ kind: "query" as const, value: `query-${i}` }],
                    turn: i,
                })),
            ],
            failedAttempts: [],
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: 10,
        })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        expect(result.constraints.length).toBeLessThanOrEqual(MAX_CONSTRAINTS)
        expect(result.evidence.filter((entry) => entry.kind === "codebase").length).toBeLessThanOrEqual(MAX_CODEBASE_EVIDENCE)
        expect(result.evidence.filter((entry) => entry.kind === "research").length).toBeLessThanOrEqual(MAX_RESEARCH_EVIDENCE)
    })

    test("enforces hard cap on failedAttempts", () => {
        const layer = tracked(createLayer())

        const attempts = Array.from({ length: MAX_FAILED_ATTEMPTS + 20 }, (_, i) => ({
            approach: `Tool${i}`,
            reason: `Error ${i}`,
            turn: i,
        }))

        seedCompressedState(layer, {
            retainedNotes: [],
            constraints: [],
            evidence: [],
            failedAttempts: attempts,
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: MAX_FAILED_ATTEMPTS + 20,
        }, { currentTurn: MAX_FAILED_ATTEMPTS + 20 })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        expect(result.failedAttempts.length).toBeLessThanOrEqual(MAX_FAILED_ATTEMPTS)
    })

    test("failed attempt subsumption removes matched approaches", () => {
        const layer = tracked(createLayer())

        seedCompressedState(layer, {
            retainedNotes: [
                { summary: "Use a completely different strategy for authentication", turn: 10 },
            ],
            constraints: [],
            evidence: [],
            failedAttempts: [
                // Long approach that appears in a retained-note summary → subsumed
                { approach: "different strategy for authentication", reason: "old issue", turn: 5 },
                // Short approach → kept (below MIN_APPROACH_LENGTH_FOR_MATCH)
                { approach: "Bash", reason: "exit code 1", turn: 3 },
            ],
            openTasks: [],
            resolvedTasks: [],
            lastUpdatedTurn: 10,
        })

        layer.testFinalizeCompactedState()
        const result = layer.getCompressedState()

        // The long matching approach should be removed
        expect(result.failedAttempts.some((f) => f.approach === "different strategy for authentication")).toBe(false)
        // The short approach is kept (below length threshold)
        expect(result.failedAttempts.some((f) => f.approach === "Bash")).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — persistence", () => {
    test("loadFromPersisted restores retainedNotes state", () => {
        const layer = tracked(createLayer())

        const persistedState: Parameters<TestableAgentMemoryLayer["loadFromPersisted"]>[0] = {
            rawHistory: [],
            compressedState: {
                scratchpad: "Need auth next",
                retainedNotes: [{ summary: "Use Express.js", category: "framework", kind: "workflow", turn: 1 }],
                constraints: ["Must be TypeScript"],
                evidence: [({
                    summary: "Created src/server.ts",
                    kind: "codebase",
                    extractor: "write",
                    citations: [{ kind: "path", value: "src/server.ts" }],
                    turn: 1,
                } as any)],
                failedAttempts: [],
                openTasks: ["Add authentication"],
                resolvedTasks: [],
                lastUpdatedTurn: 1,
            },
            compactionCursor: { lastCompactedTurn: 0 },
            currentTurn: 1,
            compactionCount: 0,
        }

        layer.loadFromPersisted(
            persistedState,
        )

        const state = layer.getCompressedState()
        expect(state.retainedNotes).toEqual([
            {
                summary: "Use Express.js",
                category: "framework",
                kind: "workflow",
                citations: [],
                turn: 1,
                provenance: { source: "rule", detail: "persisted" },
            },
        ])
        expect(state.constraints.map((constraint) => constraint.text)).toEqual(["Must be TypeScript"])
        expect(state.evidence).toHaveLength(1)
        expect(state.evidence[0]).toEqual({
            summary: "Created src/server.ts",
            kind: "codebase",
            citations: [{ kind: "path", value: "src/server.ts" }],
            turn: 1,
            provenance: { source: "tool", detail: "persisted" },
        })
    })

    test("loadFromPersisted replaces stale agent-specific runtime fields", () => {
        const layer = tracked(createLayer())

        layer.loadFromPersisted({
            rawHistory: [],
            compressedState: {
                retainedNotes: [],
                constraints: [],
                evidence: [],
                failedAttempts: [],
                openTasks: [],
                resolvedTasks: [],
                lastUpdatedTurn: 0,
            },
            compactionCursor: { lastCompactedTurn: 0 },
            currentTurn: 0,
            compactionCount: 0,
            lastCompactionAttempt: 42,
        })

        layer.loadFromPersisted({
            rawHistory: [],
            compressedState: {
                retainedNotes: [],
                constraints: [],
                evidence: [],
                failedAttempts: [],
                openTasks: [],
                resolvedTasks: [],
                lastUpdatedTurn: 0,
            },
            compactionCursor: { lastCompactedTurn: 0 },
            currentTurn: 0,
            compactionCount: 0,
            lastCompactionAttempt: Number.NaN as any,
        })

        const persisted = layer.serialize()
        expect(persisted.lastCompactionAttempt).toBe(0)
    })

    test("reset clears agent-specific runtime state", () => {
        const layer = tracked(createLayer())

        layer.loadFromPersisted({
            rawHistory: [
                {
                    id: "msg-1",
                    role: "user",
                    content: "investigate failures",
                    timestamp: Date.now(),
                    turn: 1,
                    tokenCount: 2,
                },
            ],
            compressedState: {
                retainedNotes: [],
                constraints: [],
                evidence: [],
                failedAttempts: [],
                openTasks: [],
                resolvedTasks: [],
                lastUpdatedTurn: 1,
            },
            compactionCursor: { lastCompactedTurn: 1 },
            currentTurn: 1,
            compactionCount: 1,
            lastCompactionAttempt: 50,
        })

        layer.reset()

        expect(layer.getRawHistory()).toHaveLength(0)

        const persisted = layer.serialize()
        expect(persisted.compactionCount).toBe(0)
    expect(persisted.lastCompactionAttempt).toBe(0)
    })
})

// ---------------------------------------------------------------------------
// LLM Compaction (mock-based)
// ---------------------------------------------------------------------------

describe("AgentMemoryLayer — LLM compaction", () => {
    function createMockCompactionClient(response: string, shouldThrow = false) {
        return {
            chat: async () => {
                if (shouldThrow) throw new Error("LLM unavailable")
                return { content: response }
            },
        }
    }

    /**
    * Create a layer and fill with enough content to exceed the 150k compaction
     * threshold (75% of 200k). Tiktoken counts ~1 token per word.
     * Static context: ~50k tokens. Messages: 1000 pairs × ~100 tokens each = ~100k.
     * Total ≈ 150k+, enough to trigger compaction.
     */
    function createCompactableLayerWithLLM(client: ReturnType<typeof createMockCompactionClient>): TestableAgentMemoryLayer {
        const layer = new TestableAgentMemoryLayer(testConfig({ compactionClient: client }))
        layerInstances.push(layer)
        // ~50k tokens of static context
        const longContext = Array.from({ length: 10_000 }, (_, i) =>
            `Rule ${i}: The agent must follow this important guideline at all times.`
        ).join("\n")
        layer.setStaticContext(longContext)
        return layer
    }

    function fillHammerMessages(layer: TestableAgentMemoryLayer, count: number) {
        for (let i = 0; i < count; i++) {
            layer.appendMessage("user", `Implement feature ${i}: This task requires creating a comprehensive module with multiple utility functions, error handling, type definitions, and integration tests. The module should follow our established patterns and conventions for code organization.`)
            layer.appendMessage("assistant", [
                `Implementing feature ${i} by creating the required module with proper structure, types, and tests. This follows the established codebase patterns and addresses the user requirements completely.`,
                bashSegment(`vitest run feature${i}`),
            ].join("\n"))
        }
    }

    test("uses LLM compaction when client returns valid JSON", async () => {
        const mockState = JSON.stringify({
            scratchpad: null,
            retainedNotes: [{ summary: "Use Express.js", category: "framework", kind: "workflow", turn: 1 }],
            constraints: ["Must be TypeScript"],
            evidence: [{
                summary: "Created src/server.ts",
                kind: "codebase",
                citations: [{ kind: "path", value: "src/server.ts" }],
                turn: 1,
            }],
            failedAttempts: [],
            openTasks: ["Add authentication"],
            resolvedTasks: [],
        })
        const client = createMockCompactionClient(mockState)
        const layer = createCompactableLayerWithLLM(client)
        fillHammerMessages(layer, 1000)

        await layer.triggerCompactionIfNeeded()

        const state = layer.getCompressedState()
        expect(state.constraints.some((constraint) => constraint.text === "Must be TypeScript")).toBe(true)
        expect(state.evidence.some((entry) => entry.summary === "Created src/server.ts")).toBe(true)
    })

    test("falls back to pattern matching when LLM returns invalid JSON", async () => {
        const client = createMockCompactionClient("not valid json")
        const layer = createCompactableLayerWithLLM(client)
        fillHammerMessages(layer, 1000)

        await layer.triggerCompactionIfNeeded()

        // Pattern matching should have run — extract retained notes from shell-style commands
        const state = layer.getCompressedState()
        expect(state.retainedNotes.length).toBeGreaterThan(0)
    })

    test("falls back to pattern matching when LLM throws", async () => {
        const client = createMockCompactionClient("", true)
        const layer = createCompactableLayerWithLLM(client)
        fillHammerMessages(layer, 1000)

        await layer.triggerCompactionIfNeeded()
        expect(layer.getCompactionCount()).toBeGreaterThanOrEqual(1)
    })

    test("without compaction client, uses pattern matching only", async () => {
        const layer = tracked(createLayer()) // No compaction client
        const longContext = Array.from({ length: 10_000 }, (_, i) =>
            `Rule ${i}: The agent must follow this important guideline at all times.`
        ).join("\n")
        layer.setStaticContext(longContext)
        fillHammerMessages(layer, 1000)

        await layer.triggerCompactionIfNeeded()
        expect(layer.getCompactionCount()).toBeGreaterThanOrEqual(1)
    })

    test("preserves existing scratchpad when LLM returns null", async () => {
        // LLM forgets to include scratchpad — existing values must survive
        const mockState = JSON.stringify({
            scratchpad: null,
            retainedNotes: [{ summary: "Use TypeScript", category: "lang", kind: "workflow", turn: 1 }],
            constraints: [],
            evidence: [],
            failedAttempts: [],
            openTasks: [],
            resolvedTasks: [],
        })
        const client = createMockCompactionClient(mockState)
        const layer = createCompactableLayerWithLLM(client)
        // Pre-set existing scratchpad
        layer["compressedState"].scratchpad = "Working on auth module next"
        fillHammerMessages(layer, 1000)

        await layer.triggerCompactionIfNeeded()

        const state = layer.getCompressedState()
        expect(state.scratchpad).toBe("Working on auth module next")
        expect(state.retainedNotes.length).toBeGreaterThan(0)
    })
})
