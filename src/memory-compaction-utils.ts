import type {
    CompactionLLMClient,
    MemoryMessage,
    MemoryProvenance,
} from "./memory-layer"
import { buildMemoryCompactionPrompt } from "./memory-compaction-prompts"

const MEMORY_PROVENANCE_SOURCES = new Set<MemoryProvenance["source"]>([
    "rule",
    "llm",
    "tool",
    "assistant",
    "user",
])

export interface MemoryMetadataLike {
    provenance: MemoryProvenance
}

export interface MemoryEntrySanitizerContext {
    turn: number
    provenance: MemoryProvenance
}

export function createMemoryMetadata(provenance: MemoryProvenance): MemoryMetadataLike {
    return { provenance }
}

export function buildCompactionEntry<T>(options: {
    text: string
    provenance: MemoryProvenance
    summarize: (text: string) => string
    canonicalize: (text: string) => string
    preprocess?: (text: string) => string
    canonicalizeSource?: (preprocessed: string, normalized: string) => string
    build: (normalized: string, canonical: string, metadata: MemoryMetadataLike) => T
}): T | null {
    const preprocessed = options.preprocess ? options.preprocess(options.text) : options.text
    const normalized = options.summarize(preprocessed)
    const canonicalSource = options.canonicalizeSource
        ? options.canonicalizeSource(preprocessed, normalized)
        : normalized
    const canonical = options.canonicalize(canonicalSource)

    if (!normalized || canonical.length === 0) {
        return null
    }

    return options.build(
        normalized,
        canonical,
        createMemoryMetadata(options.provenance),
    )
}

export function cleanCompactionText(text: string): string {
    return text.trim().replace(/\s+/g, " ").replace(/[.?!:;]+$/, "")
}

export function canonicalizeCompactionText(
    text: string,
    options?: {
        stopWords?: Iterable<string>
        stripQuotes?: boolean
    },
): string {
    const stopWords = new Set(Array.from(options?.stopWords ?? [], (word) => word.toLowerCase()))
    const normalized = cleanCompactionText(text)
        .toLowerCase()

    const dequoted = options?.stripQuotes === false
        ? normalized
        : normalized.replace(/["'`“”‘’]/g, "")

    return dequoted
        .replace(/[^a-z0-9./:_-]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 0 && !stopWords.has(token))
        .join(" ")
        .trim()
}

export function summarizeCompactionText(text: string, max = 160): string {
    const normalized = cleanCompactionText(text)
    if (normalized.length <= max) {
        return normalized
    }
    return normalized.slice(0, max - 1) + "…"
}

export function splitCompactionCandidates(
    text: string,
    options?: {
        minLength?: number
    },
): string[] {
    const minLength = options?.minLength ?? 8
    return text
        .split(/\r?\n+/)
        .flatMap((line) => line.split(/(?<=[.?!])\s+/))
        .map((candidate) => cleanCompactionText(candidate))
        .filter((candidate) => candidate.length >= minLength)
}

export function selectLatestByKey<T>(
    entries: T[],
    keyOf: (entry: T) => string,
    recencyOf: (entry: T) => number,
): T[] {
    const latest = new Map<string, T>()
    for (const entry of entries) {
        const key = keyOf(entry)
        const existing = latest.get(key)
        if (!existing || recencyOf(entry) > recencyOf(existing)) {
            latest.set(key, entry)
        }
    }

    return Array.from(latest.values()).sort((a, b) => recencyOf(a) - recencyOf(b))
}

export function selectLatestMatchingByKey<T>(
    entries: T[],
    options: {
        keyOf: (entry: T) => string
        recencyOf: (entry: T) => number
        include: (entry: T) => boolean
    },
): T[] {
    return selectLatestByKey(
        entries.filter((entry) => options.include(entry)),
        options.keyOf,
        options.recencyOf,
    )
}

export function limitEntriesByRecency<T>(
    entries: T[],
    limit: number,
    recencyOf: (entry: T) => number,
): T[] {
    if (entries.length <= limit) {
        return entries
    }

    return [...entries]
        .sort((a, b) => recencyOf(a) - recencyOf(b))
        .slice(-limit)
}

export function formatMemoryMetadataTag(metadata: MemoryMetadataLike): string {
    const detail = metadata.provenance.detail ? `/${metadata.provenance.detail}` : ""
    return ` [${metadata.provenance.source}${detail}]`
}

export function createEntrySanitizer<T>(options: {
    defaultProvenance: MemoryProvenance
    fromString?: (value: string, context: MemoryEntrySanitizerContext) => T | null
    fromObject: (value: Record<string, unknown>, context: MemoryEntrySanitizerContext) => T | null
    getTurn?: (value: Record<string, unknown>, fallbackTurn: number) => number
    getProvenance?: (value: Record<string, unknown>) => unknown
}): (input: unknown, fallbackTurn: number, fallbackProvenance?: MemoryProvenance) => T[] {
    return (input, fallbackTurn, fallbackProvenance = options.defaultProvenance) => {
        if (!Array.isArray(input)) return []
        return input.flatMap((value) => {
            if (typeof value === "string") {
                const entry = options.fromString?.(value, { turn: fallbackTurn, provenance: fallbackProvenance })
                return entry ? [entry] : []
            }
            if (!value || typeof value !== "object") return []
            const obj = value as Record<string, unknown>
            const rawProv = options.getProvenance?.(obj) ?? obj.provenance
            let provenance = fallbackProvenance
            if (rawProv && typeof rawProv === "object") {
                const c = rawProv as Record<string, unknown>
                const source = typeof c.source === "string" ? c.source : undefined
                if (source && MEMORY_PROVENANCE_SOURCES.has(source as MemoryProvenance["source"])) {
                    provenance = {
                        source: source as MemoryProvenance["source"],
                        detail: typeof c.detail === "string" ? c.detail : fallbackProvenance.detail,
                    }
                }
            }
            const entry = options.fromObject(obj, {
                turn: options.getTurn?.(obj, fallbackTurn)
                    ?? (typeof obj.turn === "number" && Number.isFinite(obj.turn)
                        ? obj.turn
                        : fallbackTurn),
                provenance,
            })
            return entry ? [entry] : []
        })
    }
}

export async function runStructuredLLMCompaction<
    TMessage extends MemoryMessage,
    TState,
>(options: {
    client?: CompactionLLMClient
    currentState: string
    messages: TMessage[]
    formatMessage: (message: TMessage) => string
    persona: string
    schema: string
    rules: string[]
    temperature?: number
    maxTokens?: number
    parseState: (obj: Record<string, unknown>) => TState | null
}): Promise<TState | null> {
    if (!options.client) {
        return null
    }

    const messageBlock = options.messages
        .map((message) => options.formatMessage(message))
        .join("\n")

    const prompt = buildMemoryCompactionPrompt({
        persona: options.persona,
        currentState: options.currentState,
        messageBlock,
        schema: options.schema,
        rules: options.rules,
    })

    const result = await options.client.chat({
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature ?? 0.1,
        maxTokens: options.maxTokens ?? 4096,
        stream: false,
    })

    let parsed: Record<string, unknown> | null = null
    try {
        const cleaned = result.content.replace(/```json\n?|```\n?/gi, "").trim()
        const obj = JSON.parse(cleaned)
        parsed = obj && typeof obj === "object" ? obj as Record<string, unknown> : null
    } catch {
        parsed = null
    }
    return parsed ? options.parseState(parsed) : null
}