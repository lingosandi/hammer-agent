/**
 * Agent Memory Layer Factory — Shared factory for creating pre-configured
 * AgentMemoryLayer instances.
 *
 * Centralizes the shared Hammer/Magic/Monoslides/Monospace memory-layer presets so each
 * agent only provides the small set of overrides it actually owns.
 *
 * Usage:
 *   import { createAgentMemoryLayer } from "./agent-memory-factory"
 *   const memory = createAgentMemoryLayer("hammer", { logger: myLogger })
 *   const memory = createAgentMemoryLayer("magic", { toolMemoryExtractor: canvasExtractor })
 */

import {
    AgentMemoryLayer,
    DEFAULT_TOOL_MEMORY_EXTRACTOR,
    type AgentMemoryLayerConfig,
    type ToolMemoryExtractor,
    type AgentMemoryLogger,
} from "./agent-memory-layer"
import { CharTokenEstimator } from "./memory-layer"
import type { CompactionLLMClient } from "./memory-layer"
import type { ToolDefinition } from "./types"
import {
    getCompactionLlmTemperature,
    getCompactionLlmMaxTokens,
} from "./configure"

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

interface MemoryPresetConfig {
    compactionTokenThreshold: number
    protectedContextTokens: number
    stateBudgetTokens: number
    maxRawHistory: number
    compactionDebounceTurns: number
    systemPromptOverhead: number
    toolMemoryExtractor: ToolMemoryExtractor
}

// Default preset values assume a 200k context window (matches MiniMax-M2.7 / qwen3-max).
// Consumers that use smaller or larger models should pass overrides via createAgentMemoryLayer().
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000
const SHARED_WORKSPACE_AGENT_MEMORY_PRESET: MemoryPresetConfig = {
    compactionTokenThreshold: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * 0.75),  // 150_000
    protectedContextTokens: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * 0.30),    //  60_000
    stateBudgetTokens: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * 0.05),         //  10_000
    maxRawHistory: 2_000,
    compactionDebounceTurns: 3,
    systemPromptOverhead: 4_000,
    toolMemoryExtractor: DEFAULT_TOOL_MEMORY_EXTRACTOR,
}

const PRESETS: Record<string, MemoryPresetConfig> = {
    hammer: SHARED_WORKSPACE_AGENT_MEMORY_PRESET,
    magic: SHARED_WORKSPACE_AGENT_MEMORY_PRESET,
    monoslides: SHARED_WORKSPACE_AGENT_MEMORY_PRESET,
    monospace: SHARED_WORKSPACE_AGENT_MEMORY_PRESET,
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export interface AgentMemoryFactoryOverrides {
    /** Override the compaction LLM client. */
    compactionClient?: CompactionLLMClient
    /** Override the token estimator (default: CharTokenEstimator for browser safety). */
    tokenEstimator?: AgentMemoryLayerConfig["tokenEstimator"]
    /** Provide registry-backed tool definitions for compaction-time classification. */
    getToolDefinitions?: () => ToolDefinition[]
    /** Override tool memory extractor. */
    toolMemoryExtractor?: ToolMemoryExtractor
    /** Optional structured logger. */
    logger?: AgentMemoryLogger
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AgentMemoryLayer pre-configured for a specific agent preset.
 *
 * @param preset - Agent preset name ("hammer" | "magic" | "monoslides" | "monospace").
 * @param overrides - Optional overrides for any preset value.
 * @returns Configured AgentMemoryLayer instance.
 *
 * @example
 * ```ts
 * // Hammer (Node.js — use TiktokenEstimator for precision)
 * const memory = createAgentMemoryLayer("hammer", {
 *     compactionClient,
 *     tokenEstimator: new TiktokenEstimator(),
 *     logger: hammerLogger,
 * })
 *
 * // Magic/Monoslides/Monospace (browser — CharTokenEstimator is default)
 * const memory = createAgentMemoryLayer("magic", {
 *     compactionClient,
 *     getToolDefinitions: () => registry.getToolDefinitions(),
 *     toolMemoryExtractor: MAGIC_TOOL_MEMORY_EXTRACTOR,
 * })
 * ```
 */
export function createAgentMemoryLayer(
    preset: string,
    overrides?: AgentMemoryFactoryOverrides,
): AgentMemoryLayer {
    const presetConfig = PRESETS[preset]
    if (!presetConfig) {
        throw new Error(`Unknown memory preset: "${preset}". Available: ${Object.keys(PRESETS).join(", ")}`)
    }

    return new AgentMemoryLayer({
        compactionTokenThreshold: presetConfig.compactionTokenThreshold,
        protectedContextTokens: presetConfig.protectedContextTokens,
        stateBudgetTokens: presetConfig.stateBudgetTokens,
        maxRawHistory: presetConfig.maxRawHistory,
        compactionDebounceTurns: presetConfig.compactionDebounceTurns,
        systemPromptOverhead: presetConfig.systemPromptOverhead,
        tokenEstimator: overrides?.tokenEstimator ?? new CharTokenEstimator(),
        compactionClient: overrides?.compactionClient,
        compactionTemperature: getCompactionLlmTemperature(),
        compactionMaxTokens: getCompactionLlmMaxTokens(),
        getToolDefinitions: overrides?.getToolDefinitions,
        toolMemoryExtractor: overrides?.toolMemoryExtractor ?? presetConfig.toolMemoryExtractor,
        logger: overrides?.logger,
    })
}
