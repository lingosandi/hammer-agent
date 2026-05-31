import { describe, expect, test, vi } from "vitest"
import { LLMClient } from "../src/llm-client"
import type { LLMProviderConfig, FetchResponseLike } from "../src/types"

function createJsonResponse(payload: unknown): FetchResponseLike {
    return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
        json: async () => payload,
        body: null,
    }
}

describe("LLMClient thinking payload mapping", () => {
    test("maps enableThinking to DeepSeek thinking object", async () => {
        const fetchImpl = vi.fn(async () =>
            createJsonResponse({
                choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        )

        const config: LLMProviderConfig = {
            apiKey: "key",
            baseUrl: "https://api.deepseek.com",
            model: "deepseek-v4-flash",
            enableThinking: true,
            fetchImpl,
        }

        const client = new LLMClient(config)
        await client.chat({
            messages: [{ role: "user", content: "hi" }],
            stream: false,
        })

        const request = fetchImpl.mock.calls[0]?.[1]
        const payload = JSON.parse(String(request?.body))

        expect(payload.thinking).toEqual({ type: "enabled" })
        expect(payload.enable_thinking).toBeUndefined()
    })

    test("maps enableThinking to enable_thinking for non-DeepSeek providers", async () => {
        const fetchImpl = vi.fn(async () =>
            createJsonResponse({
                choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        )

        const config: LLMProviderConfig = {
            apiKey: "key",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            model: "qwen-plus",
            enableThinking: false,
            fetchImpl,
        }

        const client = new LLMClient(config)
        await client.chat({
            messages: [{ role: "user", content: "hi" }],
            stream: false,
        })

        const request = fetchImpl.mock.calls[0]?.[1]
        const payload = JSON.parse(String(request?.body))

        expect(payload.enable_thinking).toBe(false)
        expect(payload.thinking).toBeUndefined()
    })
})
