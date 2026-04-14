import { describe, expect, test, beforeEach } from "vitest"
import { configure, getProviderConfig } from "../src/configure"

describe("configure", () => {
    test("registers a provider and retrieves it", () => {
        configure({
            providers: {
                minimax: {
                    apiKey: "test-key",
                    baseUrl: "https://api.example.com",
                    model: "test-model",
                },
            },
        })

        const config = getProviderConfig("minimax")
        expect(config.apiKey).toBe("test-key")
        expect(config.baseUrl).toBe("https://api.example.com")
        expect(config.model).toBe("test-model")
    })

    test("throws for unconfigured provider", () => {
        expect(() => getProviderConfig("nonexistent" as any)).toThrow(
            'provider "nonexistent" is not configured',
        )
    })

    test("merges multiple configure calls", () => {
        configure({
            providers: {
                openrouter: {
                    apiKey: "key-1",
                    baseUrl: "https://openrouter.ai/api/v1",
                    model: "model-1",
                },
            },
        })

        configure({
            providers: {
                minimax: {
                    apiKey: "key-2",
                    baseUrl: "https://minimax.com",
                    model: "model-2",
                },
            },
        })

        // Both should be accessible
        expect(getProviderConfig("openrouter").apiKey).toBe("key-1")
        expect(getProviderConfig("minimax").apiKey).toBe("key-2")
    })

    test("later configure overwrites same provider", () => {
        configure({
            providers: {
                minimax: {
                    apiKey: "old-key",
                    baseUrl: "https://old.com",
                    model: "old-model",
                },
            },
        })

        configure({
            providers: {
                minimax: {
                    apiKey: "new-key",
                    baseUrl: "https://new.com",
                    model: "new-model",
                },
            },
        })

        const config = getProviderConfig("minimax")
        expect(config.apiKey).toBe("new-key")
    })
})
