/**
 * Shared Agent Memory Layer with Episodic Compaction
 *
 * Extends BaseMemoryLayer with agent-specific compressed state:
 * - Retained notes, constraints, structured evidence, failed attempts
 * - Compaction patterns (shell-line command parsing, tool/result extraction)
 * - Compaction rules (retained-note canonicalization, failure subsuming)
 * - LLM-based compaction with structured prompts
 *
 * Used by both Hammer CLI and Magic browser agents. Consumers configure
 * agent-specific behaviour via AgentMemoryLayerConfig (logger, tool names,
 * token budgets, etc.).
 */

import {
    BaseMemoryLayer,
    type CompactionLLMClient,
    type MemoryMessage,
    type MemoryProvenance,
    type PersistedMemoryData,
    type TokenEstimator,
} from "./memory-layer"
import type { ConversationAdapter } from "./agent-loop"
import {
    coerceToolCallToDefinition,
    parseStructuredAgentText,
} from "./command-response-utils"
import {
    resolveToolDefinitionForInvocation,
    extractPrimaryCommandMetadata,
    formatToolCallAsUnixCommand,
    isBackgroundBashToolCall,
    isBashToolCall,
} from "./unix-tooling"
import { parseToolResultMessage } from "./tool-helpers"
import {
    buildCompactionEntry,
    canonicalizeCompactionText,
    createEntrySanitizer,
    createMemoryMetadata,
    formatMemoryMetadataTag,
    limitEntriesByRecency,
    runStructuredLLMCompaction,
    selectLatestByKey,
    selectLatestMatchingByKey,
    splitCompactionCandidates,
    summarizeCompactionText,
} from "./memory-compaction-utils"
import type {
    ToolCall,
    ToolDefinition,
    ToolMemoryCitationKind,
    ToolMemoryEvidenceKind,
    ToolMemoryEvidencePolicy,
    ToolMemoryMetadata,
    ToolMemoryNoteKind,
    ToolMemoryNotePolicy,
} from "./types"
import {
    getMaxRetainedNotes,
    getMaxFailedAttempts,
    getMaxCodebaseEvidence,
    getMaxResearchEvidence,
    getMaxConstraints,
    getMaxOpenTasks,
    getMaxResolvedTasks,
    getCompactionLlmTemperature,
    getCompactionLlmMaxTokens,
} from "./configure"

// ============================================================================
// Data Models
// ============================================================================

export interface RawMessage extends MemoryMessage {
    toolCallId?: string
}

export interface AgentMemoryCitation {
    kind: ToolMemoryCitationKind
    value: string
}

export interface AgentMemoryMetadata {
    provenance: MemoryProvenance
}

export interface AgentMemoryNote extends AgentMemoryMetadata {
    summary: string
    category?: string // Stable semantic bucket for canonicalization
    rationale?: string
    kind?: ToolMemoryNoteKind
    citations?: AgentMemoryCitation[]
    turn: number
}

export interface AgentMemoryEvidence extends AgentMemoryMetadata {
    summary: string
    kind: ToolMemoryEvidenceKind
    citations?: AgentMemoryCitation[]
    turn: number
}

export interface AgentMemoryConstraint extends AgentMemoryMetadata {
    text: string
    canonical: string
    turn: number
}

export interface AgentMemoryTask extends AgentMemoryMetadata {
    task: string
    canonical: string
    turn: number
}

export interface AgentMemoryResolvedTask extends AgentMemoryMetadata {
    task: string
    canonical: string
    resolvedTurn: number
}

export interface AgentMemoryFailedAttempt extends AgentMemoryMetadata {
    approach: string
    reason: string
    canonicalApproach: string
    turn: number
}

export type CompressedAgentState = {
    scratchpad?: string // Agent working memory — persists across compactions

    retainedNotes: AgentMemoryNote[]

    constraints: AgentMemoryConstraint[]
    evidence: AgentMemoryEvidence[]

    failedAttempts: AgentMemoryFailedAttempt[]

    openTasks: AgentMemoryTask[]
    resolvedTasks: AgentMemoryResolvedTask[]

    lastUpdatedTurn: number
}

export type MemoryMetrics = {
    totalTurns: number
    totalMessages: number
    compactedTurns: number
    compactionCount: number
    recentWindowSize: number
    protectedContextTokens: number
    compressedStateTokens: number
    estimatedContextTokens: number
}

// ============================================================================
// Logger Interface
// ============================================================================

/** Optional structured logger — avoids coupling to Hammer's `log` import. */
export interface AgentMemoryLogger {
    warn(label: string, message: string): void
}

/** No-op logger used when none is provided. */
const nullLogger: AgentMemoryLogger = {
    warn() {},
}

// ============================================================================
// Tool-specific Configuration
// ============================================================================

export interface ToolMemoryExtractionContext {
    toolName: string
    parsed: Record<string, any>
    toolDefinition?: ToolDefinition
    turn: number
}

/**
 * Defines how successful tool results should be converted into structured
 * durable memory entries.
 */
export interface ToolMemoryExtractor {
    /** Add retained notes derived from successful tool results. */
    extractNotes?(
        context: ToolMemoryExtractionContext,
    ): AgentMemoryNote[]
    /** Add durable evidence entries derived from successful tool results. */
    extractEvidence?(
        context: ToolMemoryExtractionContext,
    ): AgentMemoryEvidence[]
}

function getToolMemoryMetadata(toolDefinition?: ToolDefinition): ToolMemoryMetadata {
    return toolDefinition?.metadata?.memory ?? {}
}

function getToolNotePolicy(
    toolDefinition?: ToolDefinition,
): ToolMemoryNotePolicy | undefined {
    return getToolMemoryMetadata(toolDefinition).note
}

function getToolEvidencePolicies(
    toolDefinition?: ToolDefinition,
): ToolMemoryEvidencePolicy[] {
    return getToolMemoryMetadata(toolDefinition).evidence ?? []
}

function isSignificantToolDefinition(toolDefinition?: ToolDefinition): boolean {
    const note = getToolNotePolicy(toolDefinition)
    return !!note && note.scope !== "none"
}

function resolveToolDefinition(
    toolName: string,
    toolDefinitions: ToolDefinition[],
): ToolDefinition | undefined {
    return resolveToolDefinitionForInvocation(toolDefinitions, toolName)
}

const MEMORY_NOTE_KIND_VALUES = new Set<ToolMemoryNoteKind>([
    "workflow",
    "operation",
    "change",
])
const MEMORY_EVIDENCE_KIND_VALUES = new Set<ToolMemoryEvidenceKind>([
    "codebase",
    "research",
])
const MEMORY_CITATION_KIND_VALUES = new Set<ToolMemoryCitationKind>([
    "path",
    "query",
    "url",
    "command",
])
const CANONICAL_STOP_WORDS = new Set([
    "a",
    "an",
    "the",
    "that",
    "this",
    "these",
    "those",
    "please",
    "kindly",
    "really",
    "very",
    "just",
    "to",
    "for",
    "our",
    "your",
    "my",
    "me",
    "we",
    "you",
    "and",
])

function stripSentenceDecorators(text: string): string {
    return text
        .replace(/^[\s\-•*\d.)]+/, "")
        .replace(/[.?!:;]+$/, "")
        .trim()
}

function canonicalizeText(text: string): string {
    return canonicalizeCompactionText(stripSentenceDecorators(text), {
        stopWords: CANONICAL_STOP_WORDS,
    })
}

function summarizeSentence(text: string, max = 160): string {
    return summarizeCompactionText(stripSentenceDecorators(text), max)
}

function splitTextIntoCandidates(text: string): string[] {
    return splitCompactionCandidates(text, { minLength: 12 })
        .map((part) => stripSentenceDecorators(part))
        .filter((part) => part.length >= 12)
}

function buildConstraintEntry(
    text: string,
    turn: number,
    provenance: MemoryProvenance,
): AgentMemoryConstraint | null {
    return buildCompactionEntry({
        text,
        provenance,
        preprocess: (value) => value.replace(/^(?:constraint|constraints):\s*/i, ""),
        summarize: summarizeSentence,
        canonicalize: canonicalizeText,
        canonicalizeSource: (preprocessed) => preprocessed.replace(
            /^(?:please\s+)?(?:we\s+|you\s+)?(?:must|should|need(?:s)? to|required to|avoid|keep|do not|don't|never|without)\s+/i,
            "",
        ),
        build: (displayText, canonical, metadata) => ({
            text: displayText,
            canonical,
            turn,
            ...metadata,
        }),
    })
}

function buildTaskEntry(
    text: string,
    turn: number,
    provenance: MemoryProvenance,
): AgentMemoryTask | null {
    return buildCompactionEntry({
        text,
        provenance,
        preprocess: (value) => value
            .replace(/^(?:task|todo|next step|next|remaining):\s*/i, "")
            .replace(/^(?:please\s+)?(?:can you|could you|need to|we need to|let'?s)\s+/i, ""),
        summarize: summarizeSentence,
        canonicalize: canonicalizeText,
        build: (normalized, canonical, metadata) => ({
            task: normalized,
            canonical,
            turn,
            ...metadata,
        }),
    })
}

function buildResolvedTaskEntry(
    text: string,
    resolvedTurn: number,
    provenance: MemoryProvenance,
): AgentMemoryResolvedTask | null {
    return buildCompactionEntry({
        text,
        provenance,
        summarize: summarizeSentence,
        canonicalize: canonicalizeText,
        build: (task, canonical, metadata) => ({
            task,
            canonical,
            resolvedTurn,
            ...metadata,
        }),
    })
}

function buildFailedAttemptEntry(
    approach: string,
    reason: string,
    turn: number,
    provenance: MemoryProvenance,
): AgentMemoryFailedAttempt | null {
    const normalizedApproach = summarizeSentence(approach, 120)
    const normalizedReason = summarizeSentence(reason, 200)
    const canonicalApproach = canonicalizeText(normalizedApproach)
    if (!normalizedApproach || !normalizedReason || canonicalApproach.length === 0) {
        return null
    }

    return {
        approach: normalizedApproach,
        reason: normalizedReason,
        canonicalApproach,
        turn,
        ...createMemoryMetadata(provenance),
    }
}

function extractConstraintCandidates(text: string): string[] {
    return splitTextIntoCandidates(text).filter((candidate) =>
        /\b(?:must|should|need(?:s)? to|required to|avoid|keep|do not|don't|never|without)\b/i.test(candidate),
    )
}

function extractOpenTaskCandidates(text: string, role: RawMessage["role"]): string[] {
    const candidates = splitTextIntoCandidates(text)
    return candidates.filter((candidate) => {
        if (/^(?:todo|task|next step|next|remaining|follow-up):/i.test(candidate)) {
            return true
        }
        if (role === "user") {
            return /\?$/.test(candidate) || /\b(?:fix|build|add|update|implement|check|verify|investigate|review|compare|explain)\b/i.test(candidate)
        }
        return /\b(?:need(?:s)? to|let'?s|next|remaining)\b/i.test(candidate)
    })
}

function extractResolvedTaskCandidates(text: string): string[] {
    return splitTextIntoCandidates(text).filter((candidate) =>
        /\b(?:done|fixed|updated|implemented|completed|resolved|finished)\b/i.test(candidate),
    )
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined
}

function truncateSummary(text: string, max = 200): string {
    const normalized = text.replace(/\s+/g, " ").trim()
    if (normalized.length <= max) {
        return normalized
    }
    return normalized.slice(0, max - 1) + "…"
}

function summarizeUnknown(value: unknown, max = 200): string | undefined {
    if (typeof value === "string") {
        const summary = truncateSummary(value, max)
        return summary.length > 0 ? summary : undefined
    }

    if (Array.isArray(value)) {
        const summary = truncateSummary(
            value
                .map((item) =>
                    typeof item === "string"
                        ? item
                        : typeof item === "object" && item
                          ? JSON.stringify(item)
                          : String(item),
                )
                .join("; "),
            max,
        )
        return summary.length > 0 ? summary : undefined
    }

    if (value && typeof value === "object") {
        const summary = truncateSummary(JSON.stringify(value), max)
        return summary.length > 0 ? summary : undefined
    }

    return undefined
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === "object"
        ? value as Record<string, any>
        : undefined
}

function parseJsonLikeString(value: unknown): unknown {
    if (typeof value !== "string") {
        return value
    }

    const trimmed = value.trim()
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
        return value
    }

    try {
        return JSON.parse(trimmed)
    } catch {
        return value
    }
}

function extractWebSearchResults(parsed: Record<string, any>): Record<string, any>[] {
    const queue: unknown[] = [parsed, parsed.data, parsed.content, parsed.output]
    const seen = new Set<unknown>()

    while (queue.length > 0) {
        const current = parseJsonLikeString(queue.shift())
        if (!current || seen.has(current)) {
            continue
        }
        seen.add(current)

        const record = asRecord(current)
        if (!record) {
            continue
        }

        if (Array.isArray(record.results)) {
            return record.results.filter(
                (result): result is Record<string, any> => !!result && typeof result === "object",
            )
        }

        queue.push(record.web, record.data, record.content, record.output)
    }

    return []
}

function extractWebSummarySource(parsed: Record<string, any>): unknown {
    for (const candidate of [parsed.content, parsed.data, parsed.output]) {
        if (typeof candidate === "string") {
            if (candidate.trim().length > 0) {
                return candidate
            }
            continue
        }

        if (candidate !== undefined && candidate !== null) {
            return candidate
        }
    }

    for (const candidate of [parsed.output, parsed.content, parsed.data]) {
        const record = asRecord(parseJsonLikeString(candidate))
        if (!record) {
            continue
        }

        for (const nested of [record.content, record.data, record.output]) {
            if (typeof nested === "string") {
                if (nested.trim().length > 0) {
                    return nested
                }
                continue
            }

            if (nested !== undefined && nested !== null) {
                return nested
            }
        }
    }

    return undefined
}

const SHELL_SIGNAL_REGEX = /\b(pass(?:ed)?|fail(?:ed|ure)?|error|test(?:s)?|assert(?:ion)?|warn(?:ing)?|build(?:ing)?|built|compile(?:d)?|create(?:d)?|update(?:d)?|delete(?:d)?|remove(?:d)?|install(?:ed)?|generate(?:d)?|save(?:d)?|wrote|written|rename(?:d)?|move(?:d)?|cop(?:y|ied)|chang(?:e|ed))\b/i
const SHELL_STATUS_LINE_REGEX = /^(?:[?MADRCU!]{1,2}\s+|On branch\b|Changes?(?: not staged)?\b|nothing to commit\b|total \d+\b|[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)/
const SHELL_FILENAME_REGEX = /\b(?:package\.json|bunfig\.toml|tsconfig(?:\.[\w-]+)?\.json|README\.md|Dockerfile(?:\.\w+)?|[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|toml|yml|yaml|sh|py|rs|go|java|c|cpp|h|lock))\b/i
const MAX_SHORT_SHELL_OUTPUT = 800
const MAX_MEDIUM_SHELL_OUTPUT = 2000
const MAX_COMPACT_SHELL_LINES = 6

function hasStructuredShellSignal(text: string): boolean {
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)

    if (lines.length === 0) {
        return false
    }

    if (lines.length <= MAX_COMPACT_SHELL_LINES && text.length <= MAX_MEDIUM_SHELL_OUTPUT) {
        return true
    }

    return lines.slice(0, 12).some((line) =>
        SHELL_STATUS_LINE_REGEX.test(line) || SHELL_FILENAME_REGEX.test(line),
    )
}

function summarizeShellStream(value: unknown, max = 220): string | undefined {
    const text = asNonEmptyString(value)
    if (!text) {
        return undefined
    }

    if (text.length > MAX_SHORT_SHELL_OUTPUT) {
        const keepLargeOutput = SHELL_SIGNAL_REGEX.test(text)
            || hasStructuredShellSignal(text)
        if (!keepLargeOutput) {
            return undefined
        }
    }

    return truncateSummary(text, max)
}

function buildCitation(
    kind: ToolMemoryCitationKind,
    value: string | undefined,
): AgentMemoryCitation[] {
    return value ? [{ kind, value }] : []
}

function getCitationValue(
    parsed: Record<string, any>,
    kind?: ToolMemoryCitationKind,
): string | undefined {
    switch (kind) {
        case "path":
            return asNonEmptyString(parsed.path)
        case "query":
            return asNonEmptyString(parsed.query)
        case "url":
            return asNonEmptyString(parsed.url)
        case "command":
            return asNonEmptyString(parsed.command)
        default:
            return undefined
    }
}

function formatWebSearchEvidence(parsed: Record<string, any>): string | undefined {
    const query = asNonEmptyString(parsed.query)

    const searchResults = extractWebSearchResults(parsed)
    if (searchResults.length > 0) {
        const titles = searchResults
            .map((result) => {
                return asNonEmptyString(result.title)
                    ?? asNonEmptyString(result.snippet)
                    ?? asNonEmptyString(result.url)
            })
            .filter((title): title is string => !!title)
        if (titles.length > 0) {
            const label = query ? `Search results for "${query}"` : "Search results"
            return `${label}: ${truncateSummary(titles.slice(0, 3).join("; "))}`
        }
    }

    const fallback = summarizeUnknown(extractWebSummarySource(parsed), 220)
    if (!fallback) {
        return undefined
    }
    return query ? `Search results for "${query}": ${fallback}` : `Search results: ${fallback}`
}

function formatWebRequestEvidence(parsed: Record<string, any>): string | undefined {
    const url = asNonEmptyString(parsed.url)
    const summary = summarizeUnknown(extractWebSummarySource(parsed), 220)
    if (!summary) {
        return url ? `Fetched ${url}` : undefined
    }
    return url ? `Fetched ${url}: ${summary}` : `Fetched content: ${summary}`
}

function formatShellEvidence(parsed: Record<string, any>): string | undefined {
    const primarySummary = summarizeShellStream(parsed.stdout ?? parsed.output)
    const stderrSummary = summarizeShellStream(parsed.stderr, 140)

    if (!primarySummary && !stderrSummary) {
        return undefined
    }

    const command = asNonEmptyString(parsed.command)
    const summary = primarySummary && stderrSummary && primarySummary !== stderrSummary
        ? `${primarySummary} [stderr: ${stderrSummary}]`
        : primarySummary ?? `stderr: ${stderrSummary}`

    return command
        ? `Shell "${truncateSummary(command, 80)}": ${summary}`
        : `Shell output: ${summary}`
}

function buildDefaultEvidenceSummary(
    policy: ToolMemoryEvidencePolicy,
    parsed: Record<string, any>,
): string | undefined {
    switch (policy.citation) {
        case "query":
            return formatWebSearchEvidence(parsed)
        case "url":
            return formatWebRequestEvidence(parsed)
        case "command":
            return formatShellEvidence(parsed)
        default:
            return undefined
    }
}

function buildEvidenceFromPolicies(
    parsed: Record<string, any>,
    toolDefinition: ToolDefinition | undefined,
    turn: number,
): AgentMemoryEvidence[] {
    const entries: AgentMemoryEvidence[] = []

    for (const policy of getToolEvidencePolicies(toolDefinition)) {
        const summary = buildDefaultEvidenceSummary(policy, parsed)
        if (!summary) {
            continue
        }

        entries.push({
            summary,
            kind: policy.kind,
            citations: policy.citation
                ? buildCitation(policy.citation, getCitationValue(parsed, policy.citation))
                : undefined,
            turn,
            provenance: {
                source: "tool",
                detail: toolDefinition?.name,
            },
        })
    }

    return entries
}

/**
 * Default tool-memory extractor for Hammer-style tools. Tool definitions carry
 * the policy; this default implementation turns those policies into structured
 * evidence entries.
 */
export const DEFAULT_TOOL_MEMORY_EXTRACTOR: ToolMemoryExtractor = {
    extractNotes(): AgentMemoryNote[] {
        return []
    },
    extractEvidence(context: ToolMemoryExtractionContext): AgentMemoryEvidence[] {
        return buildEvidenceFromPolicies(
            context.parsed,
            context.toolDefinition,
            context.turn,
        )
    },
}

function getToolCallTargets(toolCall: {
    name: string
    kind?: ToolCall["kind"]
    parameters?: Record<string, any>
}, toolDefinitions: ToolDefinition[]): Array<{ name: string; path?: string; command?: string }> {
    const normalizedToolCall = {
        ...toolCall,
        parameters: toolCall.parameters ?? {},
    }
    const unixCommand = formatToolCallAsUnixCommand(normalizedToolCall, toolDefinitions)
    if (unixCommand && isBashToolCall(normalizedToolCall)) {
        const primary = extractPrimaryCommandMetadata(unixCommand)
        return [
            {
                name: "Bash",
                path:
                    primary.path ??
                    normalizedToolCall.parameters.path ??
                    normalizedToolCall.parameters.file_path,
                command: primary.command,
            },
        ]
    }

    if (unixCommand && isBackgroundBashToolCall(normalizedToolCall)) {
        return [
            {
                name: "BackgroundBash",
                path:
                    normalizedToolCall.parameters.path ||
                    normalizedToolCall.parameters.file_path,
                command: unixCommand,
            },
        ]
    }

    return [
        {
            name: normalizedToolCall.name,
            path:
                normalizedToolCall.parameters.path ||
                normalizedToolCall.parameters.file_path,
            command: normalizedToolCall.parameters.command,
        },
    ]
}

function buildRetainedNoteFromToolCall(
    target: { name: string; path?: string; command?: string },
    toolDefinition: ToolDefinition | undefined,
    turn: number,
): AgentMemoryNote | null {
    const notePolicy = getToolNotePolicy(toolDefinition)
    if (!notePolicy || notePolicy.scope === "none") {
        return null
    }

    const canonicalToolName = toolDefinition?.name ?? target.name
    const trimmedPath = asNonEmptyString(target.path)
    const trimmedCommand = asNonEmptyString(target.command)

    // Shell invocations are canonicalized by command because they do not have a
    // stable file path target the way file-oriented tools do.
        const summary = canonicalToolName === "Bash" || canonicalToolName === "BackgroundBash"
        ? `bash: ${truncateSummary(trimmedCommand ?? canonicalToolName, 80)}`
        : trimmedCommand
          ? `${canonicalToolName}: ${truncateSummary(trimmedCommand, 80)}`
          : trimmedPath
            ? `${canonicalToolName}: ${trimmedPath}`
            : canonicalToolName

        const citations = canonicalToolName === "Bash" || canonicalToolName === "BackgroundBash"
        ? buildCitation("command", trimmedCommand)
        : trimmedPath
          ? buildCitation("path", trimmedPath)
          : buildCitation("command", trimmedCommand)

    return {
        summary,
        category: `tool_${canonicalToolName}`,
        kind: notePolicy.kind,
        citations: citations.length > 0 ? citations : undefined,
        turn,
        provenance: {
            source: "assistant",
            detail: canonicalToolName,
        },
    }
}

function createRetainedNoteKey(note: AgentMemoryNote): string {
    // Categories let compaction collapse superseded notes even when the summary
    // text changes, e.g. framework choices or repeated tool operations.
    return (
        note.category
        ?? note.summary
            .toLowerCase()
            .split(/\s+/)
            .slice(0, 3)
            .join("_")
    )
}

function createEvidenceKey(entry: AgentMemoryEvidence): string {
    const citationKey = entry.citations
        ?.map((citation) => `${citation.kind}:${citation.value}`)
        .sort()
        .join("|")

    return [
        entry.kind,
        citationKey ?? entry.summary.toLowerCase(),
    ].join("::")
}

function formatCitations(citations?: AgentMemoryCitation[]): string {
    if (!citations || citations.length === 0) {
        return ""
    }

    return ` [${citations.map((citation) => `${citation.kind}: ${truncateSummary(citation.value, 80)}`).join("; ")}]`
}

const PERSISTED_RULE_PROVENANCE: MemoryProvenance = { source: "rule", detail: "persisted" }
const PERSISTED_TOOL_PROVENANCE: MemoryProvenance = { source: "tool", detail: "persisted" }

const sanitizeConstraintEntries = createEntrySanitizer<AgentMemoryConstraint>({
    defaultProvenance: PERSISTED_RULE_PROVENANCE,
    fromString: (value, context) => buildConstraintEntry(value, context.turn, context.provenance),
    fromObject: (constraint, context) => buildConstraintEntry(
        asNonEmptyString(constraint.text) ?? "",
        context.turn,
        context.provenance,
    ),
})

const sanitizeTaskEntries = createEntrySanitizer<AgentMemoryTask>({
    defaultProvenance: PERSISTED_RULE_PROVENANCE,
    fromString: (value, context) => buildTaskEntry(value, context.turn, context.provenance),
    fromObject: (task, context) => buildTaskEntry(
        asNonEmptyString(task.task) ?? "",
        context.turn,
        context.provenance,
    ),
})

const sanitizeResolvedTasks = createEntrySanitizer<AgentMemoryResolvedTask>({
    defaultProvenance: PERSISTED_RULE_PROVENANCE,
    fromObject: (entry, context) => buildResolvedTaskEntry(
        asNonEmptyString(entry.task) ?? "",
        context.turn,
        context.provenance,
    ),
    getTurn: (entry, fallbackTurn) =>
        typeof entry.resolvedTurn === "number" && Number.isFinite(entry.resolvedTurn)
            ? entry.resolvedTurn
            : fallbackTurn,
})

const sanitizeRetainedNotes = createEntrySanitizer<AgentMemoryNote>({
    defaultProvenance: PERSISTED_RULE_PROVENANCE,
    fromObject: (note, context) => {
        const summary = asNonEmptyString(note.summary)
        if (!summary) {
            return null
        }

        const kind = asNonEmptyString(note.kind)
        return {
            summary,
            category: asNonEmptyString(note.category),
            rationale: asNonEmptyString(note.rationale),
            kind: kind && MEMORY_NOTE_KIND_VALUES.has(kind as ToolMemoryNoteKind)
                ? kind as ToolMemoryNoteKind
                : undefined,
            citations: sanitizeCitations(note.citations),
            turn: context.turn,
            provenance: context.provenance,
        }
    },
})

const sanitizeEvidenceEntries = createEntrySanitizer<AgentMemoryEvidence>({
    defaultProvenance: PERSISTED_TOOL_PROVENANCE,
    fromObject: (entry, context) => {
        const summary = asNonEmptyString(entry.summary)
        const kind = asNonEmptyString(entry.kind)

        if (!summary || !kind) {
            return null
        }
        if (!MEMORY_EVIDENCE_KIND_VALUES.has(kind as ToolMemoryEvidenceKind)) {
            return null
        }

        return {
            summary,
            kind: kind as ToolMemoryEvidenceKind,
            citations: sanitizeCitations(entry.citations),
            turn: context.turn,
            provenance: context.provenance,
        }
    },
})

const sanitizeFailedAttempts = createEntrySanitizer<AgentMemoryFailedAttempt>({
    defaultProvenance: PERSISTED_TOOL_PROVENANCE,
    fromObject: (entry, context) => {
        const approach = asNonEmptyString(entry.approach)
        const reason = asNonEmptyString(entry.reason)

        if (!approach || !reason) {
            return null
        }

        return buildFailedAttemptEntry(
            approach,
            reason,
            context.turn,
            context.provenance,
        )
    },
    getTurn: (entry) =>
        typeof entry.turn === "number" && Number.isFinite(entry.turn)
            ? entry.turn
            : 0,
})

function sanitizeCitations(input: unknown): AgentMemoryCitation[] {
    if (!Array.isArray(input)) {
        return []
    }

    return input.flatMap((value) => {
        if (!value || typeof value !== "object") {
            return []
        }

        const citation = value as Record<string, unknown>
        const kind = asNonEmptyString(citation.kind)
        const text = asNonEmptyString(citation.value)

        if (!kind || !text || !MEMORY_CITATION_KIND_VALUES.has(kind as ToolMemoryCitationKind)) {
            return []
        }

        return [{ kind: kind as ToolMemoryCitationKind, value: text }]
    })
}

// ============================================================================
// Agent Memory Layer Config
// ============================================================================

export interface AgentMemoryLayerConfig {
    /** Token threshold that triggers compaction. */
    compactionTokenThreshold: number
    /** Tokens reserved for recent uncompressed messages. */
    protectedContextTokens: number
    /** Token budget for the rendered compressed state block. */
    stateBudgetTokens: number
    /** Hard cap on raw history entries. */
    maxRawHistory: number
    /** Minimum turns between compaction attempts. */
    compactionDebounceTurns: number
    /** Token estimate for the system prompt. */
    systemPromptOverhead: number
    /** Token estimator implementation. */
    tokenEstimator: TokenEstimator
    /** Optional LLM client for LLM-based compaction. */
    compactionClient?: CompactionLLMClient
    /** Temperature for compaction LLM calls (default: 0.1). */
    compactionTemperature?: number
    /** Max tokens for compaction LLM output (default: 4096). */
    compactionMaxTokens?: number
    /** Registry-backed tool definitions used to classify tool calls during compaction. */
    getToolDefinitions?: () => ToolDefinition[]
    /** Optional tool-memory extractor for converting tool results to state entries. */
    toolMemoryExtractor?: ToolMemoryExtractor
    /** Optional structured logger. */
    logger?: AgentMemoryLogger
}

// ============================================================================
// Initial State
// ============================================================================

function createInitialAgentState(): CompressedAgentState {
    return {
        retainedNotes: [],
        constraints: [],
        evidence: [],
        failedAttempts: [],
        openTasks: [],
        resolvedTasks: [],
        lastUpdatedTurn: 0,
    }
}

// ============================================================================
// Agent Memory Layer
// ============================================================================

export class AgentMemoryLayer extends BaseMemoryLayer<CompressedAgentState, RawMessage> {
    /** Temporary storage for toolCallId during appendMessage. */
    private pendingToolCallId?: string

    /** The agent-level config (superset of base MemoryLayerConfig). */
    private readonly agentConfig: Required<
        Pick<AgentMemoryLayerConfig, "logger">
    > & {
        getToolDefinitions: () => ToolDefinition[]
        toolMemoryExtractor: ToolMemoryExtractor
    }

    constructor(config: AgentMemoryLayerConfig) {
        super(
            {
                compactionTokenThreshold: config.compactionTokenThreshold,
                protectedContextTokens: config.protectedContextTokens,
                stateBudgetTokens: config.stateBudgetTokens,
                maxRawHistory: config.maxRawHistory,
                compactionDebounceTurns: config.compactionDebounceTurns,
                systemPromptOverhead: config.systemPromptOverhead,
                tokenEstimator: config.tokenEstimator,
                compactionClient: config.compactionClient,
                compactionTemperature: config.compactionTemperature ?? getCompactionLlmTemperature(),
                compactionMaxTokens: config.compactionMaxTokens ?? getCompactionLlmMaxTokens(),
            },
            createInitialAgentState(),
        )

        this.agentConfig = {
            getToolDefinitions: config.getToolDefinitions ?? (() => []),
            toolMemoryExtractor: config.toolMemoryExtractor ?? DEFAULT_TOOL_MEMORY_EXTRACTOR,
            logger: config.logger ?? nullLogger,
        }
    }

    // -----------------------------------------------------------------------
    // Override: appendMessage (preserves toolCallId support)
    // -----------------------------------------------------------------------

    /**
     * Append a message to raw history.
     * Extends the base signature with an optional toolCallId.
     */
    override appendMessage(
        role: "system" | "user" | "assistant" | "tool",
        content: string,
    ): string
    override appendMessage(
        role: "system" | "user" | "assistant" | "tool",
        content: string,
        toolCallId: string | undefined,
    ): string
    override appendMessage(message: {
        role: "system" | "user" | "assistant" | "tool"
        content: string
        toolCallId?: string
    }): string
    override appendMessage(
        roleOrMessage:
            | "system"
            | "user"
            | "assistant"
            | "tool"
            | {
                role: "system" | "user" | "assistant" | "tool"
                content: string
                toolCallId?: string
            },
        content?: string,
        toolCallId?: string,
    ): string {
        const message =
            typeof roleOrMessage === "object"
                ? roleOrMessage
                : {
                    role: roleOrMessage,
                    content: content!,
                    toolCallId,
                }

        this.pendingToolCallId = message.toolCallId
        const id = super.appendMessage(message.role, message.content)
        this.pendingToolCallId = undefined
        return id
    }

    // -----------------------------------------------------------------------
    // Abstract Implementation
    // -----------------------------------------------------------------------

    protected createMessage(
        id: string,
        role: "system" | "user" | "assistant" | "tool",
        content: string,
        turn: number,
        timestamp: number,
    ): RawMessage {
        return {
            id,
            role,
            content,
            timestamp,
            turn,
            tokenCount: this.config.tokenEstimator.estimateTokens(content),
            ...(this.pendingToolCallId && { toolCallId: this.pendingToolCallId }),
        }
    }

    protected performCompaction(messages: RawMessage[]): void {
        const { getToolDefinitions, toolMemoryExtractor } = this.agentConfig
        const toolDefinitions = getToolDefinitions()

        for (const msg of messages) {
            if (msg.role === "user") {
                for (const candidate of extractConstraintCandidates(msg.content)) {
                    const constraint = buildConstraintEntry(
                        candidate,
                        msg.turn,
                        { source: "user", detail: "message" },
                    )
                    if (constraint) {
                        this.compressedState.constraints.push(constraint)
                    }
                }

                for (const candidate of extractOpenTaskCandidates(msg.content, msg.role)) {
                    const task = buildTaskEntry(
                        candidate,
                        msg.turn,
                        { source: "user", detail: "message" },
                    )
                    if (task) {
                        this.compressedState.openTasks.push(task)
                    }
                }
            }

            if (msg.role === "assistant") {
                const retainedNoteMatches = msg.content.matchAll(
                    /\[RETAINED_NOTE\]\s*([\s\S]+?)(?=\n\[|$)/g,
                )
                for (const retainedNoteMatch of retainedNoteMatches) {
                    const summary = retainedNoteMatch[1]?.trim()
                    if (!summary) {
                        continue
                    }

                    this.compressedState.retainedNotes.push({
                        summary,
                        kind: "workflow",
                        turn: msg.turn,
                        provenance: { source: "assistant", detail: "retained_note" },
                    })
                }

                const parsed = this.extractStructuredResponse(msg.content)
                if (parsed) {
                    const selectedToolCall = coerceToolCallToDefinition(
                        parsed.selectedToolCall,
                        toolDefinitions,
                    )

                    if (parsed.reasoning && selectedToolCall) {
                        for (const target of getToolCallTargets(selectedToolCall, toolDefinitions)) {
                            const toolDefinition = resolveToolDefinition(
                                target.name,
                                toolDefinitions,
                            )
                            if (!isSignificantToolDefinition(toolDefinition)) {
                                continue
                            }

                            const note = buildRetainedNoteFromToolCall(
                                target,
                                toolDefinition,
                                msg.turn,
                            )
                            if (note) {
                                this.compressedState.retainedNotes.push(note)
                            }
                        }
                    }

                    // Extract scratchpad (latest overwrites previous)
                    if (parsed.scratchpad && typeof parsed.scratchpad === "string") {
                        this.compressedState.scratchpad = parsed.scratchpad
                    }

                    const assistantContext = [parsed.reasoning, parsed.outcome, parsed.scratchpad]
                        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
                        .join("\n")

                    for (const candidate of extractConstraintCandidates(assistantContext)) {
                        const constraint = buildConstraintEntry(
                            candidate,
                            msg.turn,
                            { source: "assistant", detail: "structured_response" },
                        )
                        if (constraint) {
                            this.compressedState.constraints.push(constraint)
                        }
                    }

                    for (const candidate of extractOpenTaskCandidates(assistantContext, msg.role)) {
                        const task = buildTaskEntry(
                            candidate,
                            msg.turn,
                            { source: "assistant", detail: "structured_response" },
                        )
                        if (task) {
                            this.compressedState.openTasks.push(task)
                        }
                    }

                    for (const candidate of extractResolvedTaskCandidates(assistantContext)) {
                        const resolved = buildResolvedTaskEntry(
                            candidate,
                            msg.turn,
                            { source: "assistant", detail: "structured_response" },
                        )
                        if (resolved) {
                            this.compressedState.resolvedTasks.push(resolved)
                        }
                    }
                }
            }

            if (msg.role === "tool" && msg.toolCallId) {
                const toolInfo = this.parseToolResponse(msg.content)

                if (!toolInfo.success && toolInfo.toolName) {
                    const failedAttempt = buildFailedAttemptEntry(
                        toolInfo.toolName,
                        (toolInfo.error || "Unknown error").substring(0, 200),
                        msg.turn,
                        { source: "tool", detail: toolInfo.toolName },
                    )
                    if (failedAttempt) {
                        this.compressedState.failedAttempts.push(failedAttempt)
                    }
                } else if (toolInfo.success && toolInfo.toolName) {
                    if (toolInfo.parsed) {
                        const toolDefinition = resolveToolDefinition(
                            toolInfo.toolName,
                            toolDefinitions,
                        )
                        const extractionContext: ToolMemoryExtractionContext = {
                            toolName: toolInfo.toolName,
                            parsed: toolInfo.parsed,
                            toolDefinition,
                            turn: msg.turn,
                        }
                        this.compressedState.retainedNotes.push(
                            ...sanitizeRetainedNotes(
                                toolMemoryExtractor.extractNotes?.(extractionContext) ?? [],
                                msg.turn,
                            ),
                        )
                        this.compressedState.evidence.push(
                            ...sanitizeEvidenceEntries(
                                toolMemoryExtractor.extractEvidence?.(extractionContext) ?? [],
                                msg.turn,
                            ),
                        )
                    }
                }
            }
        }

        this.compressedState.lastUpdatedTurn = this.currentTurn
        this.finalizeCompactedState()
    }

    protected override async performLLMCompaction(messages: RawMessage[]): Promise<boolean> {
        const parsed = await runStructuredLLMCompaction({
            client: this.config.compactionClient,
            currentState: this.renderState(),
            messages,
            formatMessage: (message) => {
                const prefix = message.toolCallId
                    ? `[${message.role} tool=${message.toolCallId} turn=${message.turn}]`
                    : `[${message.role} turn=${message.turn}]`
                const content = message.content.length > 2000
                    ? message.content.slice(0, 1997) + "…"
                    : message.content
                return `${prefix} ${content}`
            },
            persona: "You are an agent memory compactor for a coding assistant. Given the conversation messages and current compacted state, produce an UPDATED compacted state as JSON.",
            schema: '{"scratchpad":"string or null — working memory notes","retainedNotes":[{"summary":"string","category":"string or null","rationale":"string or null","kind":"workflow|operation|change or null","citations":[{"kind":"path|query|url|command","value":"string"}],"turn":number,"provenance":{"source":"rule|llm|tool|assistant|user","detail":"string or null"}}],"constraints":[{"text":"string","canonical":"string","turn":number,"provenance":{"source":"rule|llm|tool|assistant|user","detail":"string or null"}}],"evidence":[{"summary":"string","kind":"codebase|research","citations":[{"kind":"path|query|url|command","value":"string"}],"turn":number,"provenance":{"source":"rule|llm|tool|assistant|user","detail":"string or null"}}],"failedAttempts":[{"approach":"string","reason":"string","canonicalApproach":"string","turn":number,"provenance":{"source":"rule|llm|tool|assistant|user","detail":"string or null"}}],"openTasks":[{"task":"string","canonical":"string","turn":number,"provenance":{"source":"rule|llm|tool|assistant|user","detail":"string or null"}}],"resolvedTasks":[{"task":"string","canonical":"string","resolvedTurn":number,"provenance":{"source":"rule|llm|tool|assistant|user","detail":"string or null"}}]}',
            rules: [
                "Merge new information with existing state — preserve existing entries unless superseded",
                'For retained notes, keep categories stable for repeated tool operations (e.g. "tool_Bash" or "tool_WebSearch")',
                "Preserve citations when available",
                "Keep evidence specific and attributable; prefer one latest entry per evidence kind and citation, or per evidence kind and summary when uncited",
                "Keep failed attempts for learning — only drop if clearly superseded by a later success",
                "Normalize constraints and tasks into stable canonical strings so duplicates merge even when wording differs",
                "Preserve the scratchpad if present",
                "Return ONLY valid JSON — no markdown fences, no commentary",
            ],
            temperature: this.config.compactionTemperature,
            maxTokens: this.config.compactionMaxTokens,
            parseState: (obj) => this.parseLLMCompactionObject(obj),
        })
        if (parsed) {
            this.compressedState = parsed
            this.finalizeCompactedState()
            return true
        }
        return false
    }

    private parseLLMCompactionObject(obj: Record<string, unknown>): CompressedAgentState | null {
        return {
            scratchpad: typeof obj.scratchpad === "string" ? obj.scratchpad : this.compressedState.scratchpad,
            retainedNotes: sanitizeRetainedNotes(obj.retainedNotes, this.currentTurn, { source: "llm", detail: "compaction" }),
            constraints: sanitizeConstraintEntries(obj.constraints, this.currentTurn, { source: "llm", detail: "compaction" }),
            evidence: sanitizeEvidenceEntries(obj.evidence, this.currentTurn, { source: "llm", detail: "compaction" }),
            failedAttempts: sanitizeFailedAttempts(obj.failedAttempts, this.currentTurn, { source: "llm", detail: "compaction" }),
            openTasks: sanitizeTaskEntries(obj.openTasks, this.currentTurn, { source: "llm", detail: "compaction" }),
            resolvedTasks: sanitizeResolvedTasks(obj.resolvedTasks, this.currentTurn, { source: "llm", detail: "compaction" }),
            lastUpdatedTurn: this.currentTurn,
        }
    }

    private finalizeCompactedState(): void {
        this.compressedState.retainedNotes = selectLatestByKey(
            this.compressedState.retainedNotes,
            createRetainedNoteKey,
            (retainedNote) => retainedNote.turn,
        )

        this.compressedState.evidence = selectLatestByKey(
            this.compressedState.evidence,
            createEvidenceKey,
            (entry) => entry.turn,
        )

        this.compressedState.resolvedTasks = selectLatestMatchingByKey(
            this.compressedState.resolvedTasks,
            {
                keyOf: (task) => task.canonical,
                recencyOf: (task) => task.resolvedTurn,
                include: (task) => this.currentTurn - task.resolvedTurn < 20,
            },
        )

        this.compressedState.failedAttempts =
            this.compressedState.failedAttempts.filter(
                (fa) => this.currentTurn - fa.turn < 30,
            )

        this.compressedState.constraints = selectLatestByKey(
            this.compressedState.constraints,
            (constraint) => constraint.canonical,
            (constraint) => constraint.turn,
        )

        this.compressedState.openTasks = selectLatestMatchingByKey(
            this.compressedState.openTasks,
            {
                keyOf: (task) => task.canonical,
                recencyOf: (task) => task.turn,
                include: (task) => !this.compressedState.resolvedTasks.some(
                    (resolved) => resolved.canonical === task.canonical,
                ),
            },
        )

        const MIN_APPROACH_LENGTH_FOR_MATCH = 15
        const retainedNoteTexts = this.compressedState.retainedNotes.map((t) =>
            canonicalizeText(t.summary),
        )
        this.compressedState.failedAttempts =
            this.compressedState.failedAttempts.filter((attempt) => {
                const approach = attempt.canonicalApproach
                if (approach.length < MIN_APPROACH_LENGTH_FOR_MATCH) return true
                return !retainedNoteTexts.some((summary) => summary.includes(approach))
            })

        this.compressedState.retainedNotes = limitEntriesByRecency(
            this.compressedState.retainedNotes,
            getMaxRetainedNotes(),
            (retainedNote) => retainedNote.turn,
        )
        this.compressedState.failedAttempts = limitEntriesByRecency(
            this.compressedState.failedAttempts,
            getMaxFailedAttempts(),
            (failedAttempt) => failedAttempt.turn,
        )
        const codebaseEvidence = limitEntriesByRecency(
            this.compressedState.evidence.filter((entry) => entry.kind === "codebase"),
            getMaxCodebaseEvidence(),
            (entry) => entry.turn,
        )
        const researchEvidence = limitEntriesByRecency(
            this.compressedState.evidence.filter((entry) => entry.kind === "research"),
            getMaxResearchEvidence(),
            (entry) => entry.turn,
        )
        this.compressedState.evidence = [...codebaseEvidence, ...researchEvidence]
            .sort((a, b) => a.turn - b.turn)
        if (this.compressedState.constraints.length > getMaxConstraints()) {
            this.compressedState.constraints =
                this.compressedState.constraints.slice(-getMaxConstraints())
        }
        if (this.compressedState.openTasks.length > getMaxOpenTasks()) {
            this.compressedState.openTasks =
                this.compressedState.openTasks.slice(-getMaxOpenTasks())
        }
        if (this.compressedState.resolvedTasks.length > getMaxResolvedTasks()) {
            this.compressedState.resolvedTasks =
                this.compressedState.resolvedTasks.slice(-getMaxResolvedTasks())
        }
    }

    protected renderState(): string {
        const parts: string[] = []

        if (this.compressedState.scratchpad) {
            parts.push(
                `**Scratchpad (Working Memory)**:\n${this.compressedState.scratchpad}`,
            )
        }

        if (this.compressedState.retainedNotes.length > 0) {
            const retainedNotes = this.compressedState.retainedNotes
                .map(
                    (retainedNote) =>
                        `- [Turn ${retainedNote.turn}] ${retainedNote.summary}${
                            retainedNote.rationale ? ` (${retainedNote.rationale})` : ""
                        }${formatCitations(retainedNote.citations)}${formatMemoryMetadataTag(retainedNote)}`,
                )
                .join("\n")
            parts.push(`**Retained Notes**:\n${retainedNotes}`)
        }

        if (this.compressedState.constraints.length > 0) {
            parts.push(
                `**Constraints**:\n${this.compressedState.constraints
                    .map((constraint) => `- [Turn ${constraint.turn}] ${constraint.text}${formatMemoryMetadataTag(constraint)}`)
                    .join("\n")}`,
            )
        }

        const codebaseEvidence = this.compressedState.evidence.filter(
            (entry) => entry.kind === "codebase",
        )
        if (codebaseEvidence.length > 0) {
            parts.push(
                `**Codebase Evidence**:\n${codebaseEvidence
                    .map(
                        (entry) =>
                            `- [Turn ${entry.turn}] ${entry.summary}${formatCitations(entry.citations)}${formatMemoryMetadataTag(entry)}`,
                    )
                    .join("\n")}`,
            )
        }

        const researchEvidence = this.compressedState.evidence.filter(
            (entry) => entry.kind === "research",
        )
        if (researchEvidence.length > 0) {
            parts.push(
                `**Research Evidence**:\n${researchEvidence
                    .map(
                        (entry) =>
                            `- [Turn ${entry.turn}] ${entry.summary}${formatCitations(entry.citations)}${formatMemoryMetadataTag(entry)}`,
                    )
                    .join("\n")}`,
            )
        }

        if (this.compressedState.failedAttempts.length > 0) {
            const failures = this.compressedState.failedAttempts
                .map((f) => `- [Turn ${f.turn}] ${f.approach}: ${f.reason}${formatMemoryMetadataTag(f)}`)
                .join("\n")
            parts.push(`**Failed Attempts**:\n${failures}`)
        }

        if (this.compressedState.openTasks.length > 0) {
            parts.push(
                `**Open Tasks**:\n${this.compressedState.openTasks
                    .map((task) => `- [Turn ${task.turn}] ${task.task}${formatMemoryMetadataTag(task)}`)
                    .join("\n")}`,
            )
        }

        if (this.compressedState.resolvedTasks.length > 0) {
            const resolved = this.compressedState.resolvedTasks
                .map((rt) => `${rt.task} (turn ${rt.resolvedTurn})${formatMemoryMetadataTag(rt)}`)
                .join(", ")
            parts.push(`**Recently Resolved**: ${resolved}`)
        }

        return parts.join("\n\n")
    }

    protected override createInitialState(): CompressedAgentState {
        return createInitialAgentState()
    }

    protected override getStateLabel(): string {
        return "Agent State (Durable Beliefs)"
    }

    protected override getResumePlaceholder(): string {
        return "Continue working on the task."
    }

    override reset(): void {
        super.reset()
        this.pendingToolCallId = undefined
    }

    /**
     * Get comprehensive metrics for monitoring and observability
     */
    getMetrics(): MemoryMetrics {
        const recentMessages = this.getRecentMessages()
        const protectedTokens = recentMessages.reduce(
            (sum, msg) => sum + msg.tokenCount,
            0,
        )

        return {
            totalTurns: this.currentTurn,
            totalMessages: this.rawHistory.length,
            compactedTurns: this.compactionCursor.lastCompactedTurn,
            compactionCount: this.compactionCount,
            recentWindowSize: recentMessages.length,
            protectedContextTokens: protectedTokens,
            compressedStateTokens: this.estimateStateTokens(),
            estimatedContextTokens: this.estimateContextTokens(),
        }
    }

    /**
     * Create a ConversationAdapter backed by this memory layer.
     *
     * Eliminates boilerplate glue code that both Magic and Hammer
     * previously duplicated when wiring AgentLoop.
     */
    toConversationAdapter(): ConversationAdapter {
        return {
            appendMessage: async (role, content) => {
                this.appendMessage(role, content)
            },
            appendToolMessage: async (content, toolCallId) => {
                this.appendMessage("tool", content, toolCallId)
            },
            getLastMessageRole: () => this.getLastMessageRole() ?? undefined,
            getLastMessageContent: () => this.getLastMessageContent() ?? undefined,
            triggerCompactionIfNeeded: () => this.triggerCompactionIfNeeded(),
        }
    }

    /**
     * Free token estimator resources.
     * Call when the memory layer is no longer needed to prevent memory leaks.
     */
    dispose(): void {
        this.config.tokenEstimator.dispose?.()
    }

    /**
     * Serialize full agent memory state for persistence.
     * Combines base fields with agent-specific state.
     */
    serialize(): PersistedMemoryData<CompressedAgentState, RawMessage> & {
        lastCompactionAttempt: number
    } {
        return {
            ...this.serializeBase(),
            lastCompactionAttempt: this.lastCompactionAttempt,
        }
    }

    /**
     * Load from persisted data with comprehensive validation.
     * Ensures all fields have valid structure and reasonable defaults.
     */
    loadFromPersisted(data: {
        rawHistory: RawMessage[]
        compressedState: any
        compactionCursor: { lastCompactedTurn: number }
        currentTurn: number
        lastCompactionAttempt?: number
        compactionCount?: number
    }): void {
        if (!Array.isArray(data.rawHistory)) {
            throw new Error("Invalid rawHistory: must be an array")
        }

        // Sanitize base fields via shared sanitizeHistory
        const sanitizedHistory = this.sanitizeHistory(data.rawHistory)

        // Validate and sanitize compressedState
        const cs = data.compressedState
        const sanitizedState: CompressedAgentState = {
            scratchpad: cs?.scratchpad,
            retainedNotes: sanitizeRetainedNotes(cs?.retainedNotes, 0),
            constraints: sanitizeConstraintEntries(cs?.constraints, 0),
            evidence: sanitizeEvidenceEntries(cs?.evidence, 0),
            failedAttempts: sanitizeFailedAttempts(cs?.failedAttempts, 0),
            openTasks: sanitizeTaskEntries(cs?.openTasks, 0),
            resolvedTasks: sanitizeResolvedTasks(cs?.resolvedTasks, 0),
            lastUpdatedTurn:
                typeof cs?.lastUpdatedTurn === "number" ? cs.lastUpdatedTurn : 0,
        }
        const sanitizedLastCompactionAttempt =
            typeof data.lastCompactionAttempt === "number" &&
            Number.isFinite(data.lastCompactionAttempt)
                ? data.lastCompactionAttempt
                : 0

        this.loadBase({
            rawHistory: sanitizedHistory,
            compressedState: sanitizedState,
            compactionCursor: data.compactionCursor,
            currentTurn: data.currentTurn,
            compactionCount: data.compactionCount ?? 0,
        })

        // Restore agent-specific state
        this.pendingToolCallId = undefined
        this.lastCompactionAttempt = sanitizedLastCompactionAttempt
    }

    // -----------------------------------------------------------------------
    // Private Helpers
    // -----------------------------------------------------------------------

    /**
    * Extract structured assistant response data from prose plus
    * standalone control segments.
     */
    private extractStructuredResponse(text: string): {
        reasoning?: string
        outcome?: string
        selectedToolCall?: ToolCall
        scratchpad?: string
    } | null {
        const parsed = parseStructuredAgentText(text, { allowTruncated: true })
        if (!parsed) {
            return null
        }

        const scratchpadMatch = parsed.prose.match(/(?:^|\n)Scratchpad:\s*(.+)$/im)

        return {
            reasoning: parsed.prose,
            outcome: parsed.outcome,
            selectedToolCall: parsed.selectedToolCall,
            scratchpad: scratchpadMatch?.[1]?.trim(),
        }
    }

    /**
     * Safe parsing of tool response with fallback.
     * Returns structured data instead of string matching.
     */
    private parseToolResponse(content: string): {
        success: boolean
        toolName?: string
        error?: string
        /** The parsed JSON object, if parsing succeeded. */
        parsed?: Record<string, any>
    } {
        return parseToolResultMessage(content)
    }
}
