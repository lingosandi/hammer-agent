import { describe, expect, test } from "vitest"
import {
    createMemoryMetadata,
    buildCompactionEntry,
    sanitizeMemoryProvenance,
    cleanCompactionText,
    canonicalizeCompactionText,
    summarizeCompactionText,
    splitCompactionCandidates,
    selectLatestByKey,
    limitEntriesByRecency,
    formatMemoryMetadataTag,
    sanitizeCompactionEntries,
} from "../src/memory-compaction-utils"

describe("createMemoryMetadata", () => {
    test("wraps provenance in metadata object", () => {
        const metadata = createMemoryMetadata({ source: "llm", detail: "gpt-4" })
        expect(metadata.provenance).toEqual({ source: "llm", detail: "gpt-4" })
    })
})

describe("cleanCompactionText", () => {
    test("trims and collapses whitespace", () => {
        expect(cleanCompactionText("  hello   world  ")).toBe("hello world")
    })

    test("strips trailing punctuation", () => {
        expect(cleanCompactionText("done.")).toBe("done")
        expect(cleanCompactionText("really?")).toBe("really")
        expect(cleanCompactionText("wow!")).toBe("wow")
        expect(cleanCompactionText("note:")).toBe("note")
        expect(cleanCompactionText("ok;")).toBe("ok")
    })

    test("strips multiple trailing punctuation chars", () => {
        expect(cleanCompactionText("wait...")).toBe("wait")
    })
})

describe("canonicalizeCompactionText", () => {
    test("lowercases and strips non-alphanumeric", () => {
        const result = canonicalizeCompactionText("Hello, World!")
        expect(result).toBe("hello world")
    })

    test("strips quotes by default", () => {
        const result = canonicalizeCompactionText('Use "strict mode"')
        expect(result).toBe("use strict mode")
    })

    test("stripQuotes false preserves quotes in the dequoting step", () => {
        // Even with stripQuotes: false, the final [^a-z0-9./:_-] regex strips
        // non-alphanumeric chars. The option only controls the explicit dequote step.
        const withStrip = canonicalizeCompactionText('Use "strict"')
        const without = canonicalizeCompactionText('Use "strict"', { stripQuotes: false })
        // Both produce the same result because the normalization regex strips quotes
        expect(withStrip).toBe("use strict")
        expect(without).toBe("use strict")
    })

    test("filters stop words", () => {
        const result = canonicalizeCompactionText("the quick brown fox", {
            stopWords: ["the", "brown"],
        })
        expect(result).toBe("quick fox")
    })

    test("handles empty input", () => {
        expect(canonicalizeCompactionText("")).toBe("")
    })
})

describe("summarizeCompactionText", () => {
    test("returns short text as-is", () => {
        expect(summarizeCompactionText("short note")).toBe("short note")
    })

    test("truncates long text with ellipsis", () => {
        const long = "a".repeat(200)
        const result = summarizeCompactionText(long, 50)
        expect(result.length).toBe(50)
        expect(result.endsWith("…")).toBe(true)
    })

    test("respects custom max", () => {
        const result = summarizeCompactionText("hello world text", 10)
        expect(result.length).toBe(10)
    })
})

describe("splitCompactionCandidates", () => {
    test("splits on newlines", () => {
        const result = splitCompactionCandidates("line one\nline two")
        expect(result).toEqual(["line one", "line two"])
    })

    test("splits on sentence boundaries", () => {
        const result = splitCompactionCandidates("First sentence. Second sentence")
        expect(result).toEqual(["First sentence", "Second sentence"])
    })

    test("filters short candidates", () => {
        const result = splitCompactionCandidates("ok\nthis is long enough")
        expect(result).toEqual(["this is long enough"])
    })

    test("respects custom minLength", () => {
        const result = splitCompactionCandidates("ab\ncd\nefgh", { minLength: 3 })
        expect(result).toEqual(["efgh"])
    })
})

describe("selectLatestByKey", () => {
    test("deduplicates by key keeping latest", () => {
        const entries = [
            { key: "a", turn: 1 },
            { key: "a", turn: 3 },
            { key: "b", turn: 2 },
        ]
        const result = selectLatestByKey(entries, (e) => e.key, (e) => e.turn)
        expect(result).toHaveLength(2)
        expect(result.find((e) => e.key === "a")?.turn).toBe(3)
    })

    test("sorts by recency", () => {
        const entries = [
            { key: "b", turn: 5 },
            { key: "a", turn: 1 },
        ]
        const result = selectLatestByKey(entries, (e) => e.key, (e) => e.turn)
        expect(result[0].key).toBe("a")
        expect(result[1].key).toBe("b")
    })
})

describe("limitEntriesByRecency", () => {
    test("returns all entries when under limit", () => {
        const entries = [{ t: 1 }, { t: 2 }]
        expect(limitEntriesByRecency(entries, 5, (e) => e.t)).toHaveLength(2)
    })

    test("keeps most recent entries", () => {
        const entries = [{ t: 1 }, { t: 3 }, { t: 2 }, { t: 5 }, { t: 4 }]
        const result = limitEntriesByRecency(entries, 3, (e) => e.t)
        expect(result).toHaveLength(3)
        expect(result.map((e) => e.t)).toEqual([3, 4, 5])
    })
})

describe("formatMemoryMetadataTag", () => {
    test("formats source-only metadata", () => {
        expect(formatMemoryMetadataTag({ provenance: { source: "llm" } })).toBe(" [llm]")
    })

    test("formats source with detail", () => {
        expect(formatMemoryMetadataTag({ provenance: { source: "tool", detail: "bash" } })).toBe(" [tool/bash]")
    })
})

describe("sanitizeMemoryProvenance", () => {
    test("returns valid provenance", () => {
        const result = sanitizeMemoryProvenance(
            { source: "llm", detail: "test" },
            { source: "user" },
        )
        expect(result).toEqual({ source: "llm", detail: "test" })
    })

    test("returns fallback for null", () => {
        const fallback = { source: "user" as const }
        expect(sanitizeMemoryProvenance(null, fallback)).toBe(fallback)
    })

    test("returns fallback for invalid source", () => {
        const fallback = { source: "user" as const }
        expect(sanitizeMemoryProvenance({ source: "unknown" }, fallback)).toBe(fallback)
    })

    test("uses fallback detail when detail is not a string", () => {
        const result = sanitizeMemoryProvenance(
            { source: "llm", detail: 123 },
            { source: "user", detail: "fallback-detail" },
        )
        expect(result.detail).toBe("fallback-detail")
    })
})

describe("buildCompactionEntry", () => {
    test("builds entry with all transformations", () => {
        const result = buildCompactionEntry({
            text: "  Important Note!  ",
            provenance: { source: "llm" },
            summarize: (t) => t.trim(),
            canonicalize: (t) => t.toLowerCase(),
            build: (normalized, canonical, metadata) => ({
                normalized,
                canonical,
                metadata,
            }),
        })

        expect(result).not.toBeNull()
        expect(result!.normalized).toBe("Important Note!")
        expect(result!.canonical).toBe("important note!")
    })

    test("returns null for empty canonicalized text", () => {
        const result = buildCompactionEntry({
            text: "   ",
            provenance: { source: "user" },
            summarize: (t) => t.trim(),
            canonicalize: (t) => t.trim(),
            build: () => "something",
        })
        expect(result).toBeNull()
    })

    test("applies preprocess step", () => {
        const result = buildCompactionEntry({
            text: "PREFIX: real content",
            provenance: { source: "tool" },
            preprocess: (t) => t.replace("PREFIX: ", ""),
            summarize: (t) => t,
            canonicalize: (t) => t,
            build: (normalized) => normalized,
        })
        expect(result).toBe("real content")
    })
})

describe("sanitizeCompactionEntries", () => {
    test("returns empty for non-array input", () => {
        expect(sanitizeCompactionEntries("not an array", {})).toEqual([])
        expect(sanitizeCompactionEntries(null, {})).toEqual([])
    })

    test("processes string entries", () => {
        const result = sanitizeCompactionEntries(
            ["hello", "world"],
            { fromString: (s) => s.toUpperCase() },
        )
        expect(result).toEqual(["HELLO", "WORLD"])
    })

    test("processes object entries", () => {
        const result = sanitizeCompactionEntries(
            [{ text: "note" }],
            { fromObject: (obj) => obj.text as string },
        )
        expect(result).toEqual(["note"])
    })

    test("filters null results", () => {
        const result = sanitizeCompactionEntries(
            ["keep", "skip", "keep2"],
            { fromString: (s) => (s === "skip" ? null : s) },
        )
        expect(result).toEqual(["keep", "keep2"])
    })

    test("skips non-string non-object values", () => {
        const result = sanitizeCompactionEntries(
            [42, true, null, undefined],
            { fromString: (s) => s },
        )
        expect(result).toEqual([])
    })
})
