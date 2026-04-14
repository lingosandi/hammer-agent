/**
 * Agent Memory Layer Factory — Shared factory for creating pre-configured
 * AgentMemoryLayer instances.
 *
 * All agents share the same workspace-agent preset. Callers still pass
 * a preset name string (currently ignored) for call-site readability and
 * future differentiation.
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

// Default preset values assume a 200k context window (matches MiniMax-M2.7 / qwen3-max).
// Consumers that use smaller or larger models should pass overrides via createAgentMemoryLayer().
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000
const SHARED_WORKSPACE_AGENT_MEMORY_PRESET = {
    compactionTokenThreshold: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * 0.75),  // 150_000
    protectedContextTokens: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * 0.30),    //  60_000
    stateBudgetTokens: Math.floor(DEFAULT_MAX_CONTEXT_TOKENS * 0.05),         //  10_000
    maxRawHistory: 2_000,
    compactionDebounceTurns: 3,
    systemPromptOverhead: 4_000,
    toolMemoryExtractor: DEFAULT_TOOL_MEMORY_EXTRACTOR,
} as const

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
 * Create an AgentMemoryLayer pre-configured with the shared workspace defaults.
 *
 * @param _preset - Ignored. All agents share the same preset. Kept for call-site compatibility.
 * @param overrides - Optional overrides for any preset value.
 * @returns Configured AgentMemoryLayer instance.
 */
export function createAgentMemoryLayer(
    _preset: string,
    overrides?: AgentMemoryFactoryOverrides,
): AgentMemoryLayer {
    return new AgentMemoryLayer({
        compactionTokenThreshold: SHARED_WORKSPACE_AGENT_MEMORY_PRESET.compactionTokenThreshold,
        protectedContextTokens: SHARED_WORKSPACE_AGENT_MEMORY_PRESET.protectedContextTokens,
        stateBudgetTokens: SHARED_WORKSPACE_AGENT_MEMORY_PRESET.stateBudgetTokens,
        maxRawHistory: SHARED_WORKSPACE_AGENT_MEMORY_PRESET.maxRawHistory,
        compactionDebounceTurns: SHARED_WORKSPACE_AGENT_MEMORY_PRESET.compactionDebounceTurns,
        systemPromptOverhead: SHARED_WORKSPACE_AGENT_MEMORY_PRESET.systemPromptOverhead,
        tokenEstimator: overrides?.tokenEstimator ?? new CharTokenEstimator(),
        compactionClient: overrides?.compactionClient,
        compactionTemperature: getCompactionLlmTemperature(),
        compactionMaxTokens: getCompactionLlmMaxTokens(),
        getToolDefinitions: overrides?.getToolDefinitions,
        toolMemoryExtractor: overrides?.toolMemoryExtractor ?? SHARED_WORKSPACE_AGENT_MEMORY_PRESET.toolMemoryExtractor,
        logger: overrides?.logger,
    })
}
