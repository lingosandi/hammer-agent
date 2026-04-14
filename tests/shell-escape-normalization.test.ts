import { describe, expect, test } from "vitest"
import { decodeEscapedShellText } from "../src/shell-escape-normalization"

describe("decodeEscapedShellText", () => {
    test("returns text without escapes unchanged", () => {
        expect(decodeEscapedShellText("hello world")).toBe("hello world")
    })

    test("returns empty string unchanged", () => {
        expect(decodeEscapedShellText("")).toBe("")
    })

    test("decodes \\n to newline", () => {
        expect(decodeEscapedShellText("line1\\nline2")).toBe("line1\nline2")
    })

    test("decodes \\r to carriage return", () => {
        expect(decodeEscapedShellText("line1\\rline2")).toBe("line1\rline2")
    })

    test("decodes \\t to tab", () => {
        expect(decodeEscapedShellText("col1\\tcol2")).toBe("col1\tcol2")
    })

    test("decodes escaped single quote", () => {
        expect(decodeEscapedShellText("it\\'s")).toBe("it's")
    })

    test("decodes escaped double quote", () => {
        expect(decodeEscapedShellText('say \\"hello\\"')).toBe('say "hello"')
    })

    test("decodes escaped backslash", () => {
        expect(decodeEscapedShellText("path\\\\to\\\\file")).toBe("path\\to\\file")
    })

    test("decodes unicode escape \\uXXXX", () => {
        expect(decodeEscapedShellText("caf\\u00E9")).toBe("café")
    })

    test("decodes multiple unicode escapes", () => {
        expect(decodeEscapedShellText("\\u0048\\u0069")).toBe("Hi")
    })

    test("preserves unknown escape sequences with backslash", () => {
        expect(decodeEscapedShellText("\\a\\b")).toBe("\\a\\b")
    })

    test("handles mixed escapes", () => {
        expect(decodeEscapedShellText("hello\\nworld\\t\\u0021")).toBe("hello\nworld\t!")
    })

    test("handles trailing backslash", () => {
        expect(decodeEscapedShellText("path\\")).toBe("path\\")
    })

    test("handles incomplete unicode escape at end", () => {
        expect(decodeEscapedShellText("test\\u00")).toBe("test\\u00")
    })

    test("handles invalid unicode digits", () => {
        // \\uZZZZ is not valid hex — partial unicode will be emitted literally
        expect(decodeEscapedShellText("test\\uZZZZ")).toBe("test\\uZZZZ")
    })
})
