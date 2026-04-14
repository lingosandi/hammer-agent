import { describe, expect, test } from "vitest"
import {
    getDistanceFromBottom,
    shouldAutoScrollThread,
    getToolLogSummaryLine,
    stripDiagnosticMessagePrefix,
    getDiagnosticSummaryLine,
    buildToolLogRevealFrames,
    DEFAULT_THREAD_AUTO_SCROLL_BOTTOM_THRESHOLD,
} from "../src/agent-thread"

describe("getDistanceFromBottom", () => {
    test("returns 0 when scrolled to bottom", () => {
        expect(getDistanceFromBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(0)
    })

    test("returns positive distance when not at bottom", () => {
        expect(getDistanceFromBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 })).toBe(100)
    })

    test("returns 0 when content fits viewport", () => {
        expect(getDistanceFromBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 400 })).toBe(0)
    })
})

describe("shouldAutoScrollThread", () => {
    test("returns true when at bottom", () => {
        expect(shouldAutoScrollThread({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true)
    })

    test("returns true when within threshold", () => {
        const threshold = DEFAULT_THREAD_AUTO_SCROLL_BOTTOM_THRESHOLD
        expect(shouldAutoScrollThread({
            scrollHeight: 1000,
            scrollTop: 600 - threshold,
            clientHeight: 400,
        })).toBe(true)
    })

    test("returns false when far from bottom", () => {
        expect(shouldAutoScrollThread({ scrollHeight: 1000, scrollTop: 200, clientHeight: 400 })).toBe(false)
    })

    test("respects custom threshold", () => {
        expect(shouldAutoScrollThread(
            { scrollHeight: 1000, scrollTop: 550, clientHeight: 400 },
            50,
        )).toBe(true)

        expect(shouldAutoScrollThread(
            { scrollHeight: 1000, scrollTop: 500, clientHeight: 400 },
            50,
        )).toBe(false)
    })
})

describe("getToolLogSummaryLine", () => {
    test("returns first non-empty line", () => {
        expect(getToolLogSummaryLine("first line\nsecond line")).toBe("first line")
    })

    test("skips empty lines", () => {
        expect(getToolLogSummaryLine("\n\nactual content\nmore")).toBe("actual content")
    })

    test("returns empty string for all-empty content", () => {
        expect(getToolLogSummaryLine("\n\n\n")).toBe("")
    })

    test("returns empty string for empty input", () => {
        expect(getToolLogSummaryLine("")).toBe("")
    })
})

describe("stripDiagnosticMessagePrefix", () => {
    test("strips ERROR prefix", () => {
        expect(stripDiagnosticMessagePrefix("⚠️ ERROR: something broke")).toBe("something broke")
    })

    test("strips WARNING prefix", () => {
        expect(stripDiagnosticMessagePrefix("⚠️ WARNING: be careful")).toBe("be careful")
    })

    test("returns unprefixed content unchanged", () => {
        expect(stripDiagnosticMessagePrefix("normal content")).toBe("normal content")
    })
})

describe("getDiagnosticSummaryLine", () => {
    test("strips prefix and returns first line", () => {
        expect(getDiagnosticSummaryLine("⚠️ ERROR: parse failed\ndetails")).toBe("parse failed")
    })

    test("works on non-diagnostic content", () => {
        expect(getDiagnosticSummaryLine("tool output here")).toBe("tool output here")
    })
})

describe("buildToolLogRevealFrames", () => {
    test("returns single-element array for empty content", () => {
        expect(buildToolLogRevealFrames("")).toEqual([""])
    })

    test("last frame is always the full content", () => {
        const content = "line 1\nline 2\nline 3"
        const frames = buildToolLogRevealFrames(content)
        expect(frames[frames.length - 1]).toBe(content)
    })

    test("each frame extends the previous", () => {
        const content = "a".repeat(100) + "\n" + "b".repeat(100) + "\n" + "c".repeat(100)
        const frames = buildToolLogRevealFrames(content, 5)

        for (let i = 1; i < frames.length; i++) {
            expect(frames[i].length).toBeGreaterThanOrEqual(frames[i - 1].length)
        }
    })

    test("frames are prefixes of the content", () => {
        const content = "Hello world, this is a test of reveal frames!"
        const frames = buildToolLogRevealFrames(content, 5)
        for (const frame of frames) {
            expect(content.startsWith(frame)).toBe(true)
        }
    })

    test("short content produces few frames", () => {
        const frames = buildToolLogRevealFrames("hi")
        expect(frames.length).toBeLessThanOrEqual(2)
    })
})
