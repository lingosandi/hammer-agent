import { describe, expect, test } from "vitest"

import { buildMemoryCompactionPrompt } from "../src/memory-compaction-prompts"

describe("memory-compaction-prompts", () => {
    test("buildMemoryCompactionPrompt formats the shared compaction scaffold", () => {
        const prompt = buildMemoryCompactionPrompt({
            persona: "You are a memory compactor.",
            currentState: "{}",
            messageBlock: "[user turn=1] hello",
            schema: '{"items":[]}',
            rules: ["Keep entries concise", "Return ONLY valid JSON"],
        })

        expect(prompt).toContain("You are a memory compactor.")
        expect(prompt).toContain("Current compacted state:")
        expect(prompt).toContain("Messages to compact:")
        expect(prompt).toContain("Return a JSON object with exactly these fields:")
        expect(prompt).toContain('{"items":[]}')
        expect(prompt).toContain("- Keep entries concise")
        expect(prompt).toContain("- Return ONLY valid JSON")
    })
})
