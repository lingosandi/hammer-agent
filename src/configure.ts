/**
 * configure.ts — global configuration store for hammer-agent.
 *
 * Call `configure(options)` once at app startup to register provider configs
 * and optional overrides (timeouts, memory limits, etc.).
 *
 * Provider configs are looked up by name via `getProviderConfig(name)`.
 * Any name not explicitly configured falls back to a runtime error explaining
 * what to register — no hardcoded API keys ship in this library.
 */

import type { LLMProviderConfig, ProviderName } from "./types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HammerAgentProviderPreset {
    apiKey: string
    baseUrl: string
    model: string
    /** Extra headers merged into every request (e.g. HTTP-Referer for OpenRouter). */
    extraHeaders?: Record<string, string>
}

/**
 * Options accepted by `configure()`.
 *
 * `providers` is a map from provider name to provider config. You only need
 * to register the providers your agent actually uses.
 *
 * All other fields have sensible defaults and are optional.
 */
export interface HammerAgentConfig {
    /**
     * Named provider presets.  Keys are `ProviderName` strings, values are
     * provider configs.  Pass at minimum the provider(s) your agent uses.
     *
     * @example
     * configure({
     *   providers: {
     *     openrouter: { apiKey: process.env.OPENROUTER_KEY!, baseUrl: '...', model: '...' },
     *     minimax:    { apiKey: process.env.MINIMAX_KEY!,    baseUrl: '...', model: '...' },
     *   },
     *   compactionProvider: 'minimax',
     * })
     */
    providers?: Partial<Record<ProviderName, HammerAgentProviderPreset>>

    /**
     * Which provider to use for memory compaction LLM calls.
     * Must be a key in `providers`.
     * @default first key in `providers`, or throws if not configured
     */
    compactionProvider?: ProviderName

    // ---- Stream timeout overrides ----------------------------------------

    /**
     * Milliseconds without any SSE data before treating the stream as frozen.
     * @default 60_000
     */
    streamInactivityTimeout?: number

    /**
     * Maximum milliseconds to wait for the very first SSE chunk.
     * @default 120_000
     */
    firstChunkTimeout?: number

    // ---- Memory layer hard caps ------------------------------------------

    /** @default 100 */
    maxRetainedNotes?: number
    /** @default 50 */
    maxFailedAttempts?: number
    /** @default 100 */
    maxCodebaseEvidence?: number
    /** @default 50 */
    maxResearchEvidence?: number
    /** @default 50 */
    maxConstraints?: number
    /** @default 50 */
    maxOpenTasks?: number
    /** @default 50 */
    maxResolvedTasks?: number

    // ---- Compaction LLM defaults ----------------------------------------

    /** @default 0.1 */
    compactionLlmTemperature?: number
    /** @default 4096 */
    compactionLlmMaxTokens?: number
}

// ---------------------------------------------------------------------------
// Internal config store (module-level singleton)
// ---------------------------------------------------------------------------

interface ResolvedConfig {
    providers: Map<string, LLMProviderConfig>
    compactionProvider: ProviderName | null
    streamInactivityTimeout: number
    firstChunkTimeout: number
    maxRetainedNotes: number
    maxFailedAttempts: number
    maxCodebaseEvidence: number
    maxResearchEvidence: number
    maxConstraints: number
    maxOpenTasks: number
    maxResolvedTasks: number
    compactionLlmTemperature: number
    compactionLlmMaxTokens: number
}

const _config: ResolvedConfig = {
    providers: new Map(),
    compactionProvider: null,
    streamInactivityTimeout: 60_000,
    firstChunkTimeout: 120_000,
    maxRetainedNotes: 100,
    maxFailedAttempts: 50,
    maxCodebaseEvidence: 100,
    maxResearchEvidence: 50,
    maxConstraints: 50,
    maxOpenTasks: 50,
    maxResolvedTasks: 50,
    compactionLlmTemperature: 0.1,
    compactionLlmMaxTokens: 4096,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure hammer-agent at startup.
 *
 * This function is safe to call multiple times — later calls merge over
 * earlier ones, so you can split configuration across modules.
 *
 * @example
 * import { configure } from 'hammer-agent'
 *
 * configure({
 *   providers: {
 *     minimax: {
 *       apiKey: process.env.MINIMAX_KEY!,
 *       baseUrl: 'https://api.minimaxi.com/v1',
 *       model: 'MiniMax-M2.7-highspeed',
 *     },
 *   },
 *   compactionProvider: 'minimax',
 * })
 */
export function configure(options: HammerAgentConfig): void {
    if (options.providers) {
        for (const [name, preset] of Object.entries(options.providers)) {
            if (preset) {
                _config.providers.set(name, preset as LLMProviderConfig)
            }
        }
    }

    if (options.compactionProvider !== undefined) {
        _config.compactionProvider = options.compactionProvider
    }

    if (options.streamInactivityTimeout !== undefined) {
        _config.streamInactivityTimeout = options.streamInactivityTimeout
    }

    if (options.firstChunkTimeout !== undefined) {
        _config.firstChunkTimeout = options.firstChunkTimeout
    }

    if (options.maxRetainedNotes !== undefined) _config.maxRetainedNotes = options.maxRetainedNotes
    if (options.maxFailedAttempts !== undefined) _config.maxFailedAttempts = options.maxFailedAttempts
    if (options.maxCodebaseEvidence !== undefined) _config.maxCodebaseEvidence = options.maxCodebaseEvidence
    if (options.maxResearchEvidence !== undefined) _config.maxResearchEvidence = options.maxResearchEvidence
    if (options.maxConstraints !== undefined) _config.maxConstraints = options.maxConstraints
    if (options.maxOpenTasks !== undefined) _config.maxOpenTasks = options.maxOpenTasks
    if (options.maxResolvedTasks !== undefined) _config.maxResolvedTasks = options.maxResolvedTasks
    if (options.compactionLlmTemperature !== undefined) _config.compactionLlmTemperature = options.compactionLlmTemperature
    if (options.compactionLlmMaxTokens !== undefined) _config.compactionLlmMaxTokens = options.compactionLlmMaxTokens
}

/**
 * Return the `LLMProviderConfig` registered for `name`.
 * Throws a descriptive error if the provider has not been configured.
 */
export function getProviderConfig(name: ProviderName): LLMProviderConfig {
    const config = _config.providers.get(name)
    if (!config) {
        throw new Error(
            `hammer-agent: provider "${name}" is not configured. ` +
            `Call configure({ providers: { "${name}": { apiKey, baseUrl, model } } }) before using this provider.`
        )
    }

    return config
}

// ---------------------------------------------------------------------------
// Internal accessors (used by lib internals — not re-exported from index)
// ---------------------------------------------------------------------------

export function getStreamInactivityTimeout(): number {
    return _config.streamInactivityTimeout
}

export function getFirstChunkTimeout(): number {
    return _config.firstChunkTimeout
}

export function getCompactionProvider(): ProviderName | null {
    return _config.compactionProvider
}

export function getMaxRetainedNotes(): number { return _config.maxRetainedNotes }
export function getMaxFailedAttempts(): number { return _config.maxFailedAttempts }
export function getMaxCodebaseEvidence(): number { return _config.maxCodebaseEvidence }
export function getMaxResearchEvidence(): number { return _config.maxResearchEvidence }
export function getMaxConstraints(): number { return _config.maxConstraints }
export function getMaxOpenTasks(): number { return _config.maxOpenTasks }
export function getMaxResolvedTasks(): number { return _config.maxResolvedTasks }
export function getCompactionLlmTemperature(): number { return _config.compactionLlmTemperature }
export function getCompactionLlmMaxTokens(): number { return _config.compactionLlmMaxTokens }
