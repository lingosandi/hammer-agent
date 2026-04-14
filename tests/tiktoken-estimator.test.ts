import { describe, expect, test } from "vitest"
import { TiktokenEstimator } from "../src/tiktoken-estimator"

describe("TiktokenEstimator", () => {
    test("constructs without error", () => {
        const estimator = new TiktokenEstimator()
        expect(estimator).toBeInstanceOf(TiktokenEstimator)
        estimator.dispose()
    })

    test("estimates tokens for simple text", () => {
        const estimator = new TiktokenEstimator()
        const count = estimator.estimateTokens("hello world")
        expect(count).toBeGreaterThan(0)
        expect(count).toBeLessThan(10)
        estimator.dispose()
    })

    test("returns 0 tokens for empty string", () => {
        const estimator = new TiktokenEstimator()
        expect(estimator.estimateTokens("")).toBe(0)
        estimator.dispose()
    })

    test("longer text produces more tokens", () => {
        const estimator = new TiktokenEstimator()
        const short = estimator.estimateTokens("hi")
        const long = estimator.estimateTokens("The quick brown fox jumps over the lazy dog repeatedly for several sentences of text")
        expect(long).toBeGreaterThan(short)
        estimator.dispose()
    })

    test("throws after dispose", () => {
        const estimator = new TiktokenEstimator()
        estimator.dispose()
        expect(() => estimator.estimateTokens("hello")).toThrow("disposed")
    })

    test("dispose is idempotent", () => {
        const estimator = new TiktokenEstimator()
        estimator.dispose()
        estimator.dispose() // no error
    })
})
