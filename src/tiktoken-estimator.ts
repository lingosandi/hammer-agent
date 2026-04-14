/**
 * Precise token estimator using tiktoken (cl100k_base encoding).
 *
 * Separated into its own module so environments can opt into the tiktoken WASM
 * dependency explicitly. Browser runtimes should reach it through async
 * estimator helpers instead of importing it from hot paths.
 */

import { encodingForModel } from "js-tiktoken"
import type { TokenEstimator } from "./memory-layer"

type JsTiktoken = ReturnType<typeof encodingForModel>

export class TiktokenEstimator implements TokenEstimator {
    private encoder: JsTiktoken | null

    constructor() {
        try {
            this.encoder = encodingForModel("gpt-4")
        } catch (err) {
            throw new Error(
                `Failed to initialize tiktoken encoder: ${err instanceof Error ? err.message : err}`,
            )
        }
    }

    estimateTokens(text: string): number {
        if (!this.encoder) throw new Error("TiktokenEstimator has been disposed")
        return this.encoder.encode(text).length
    }

    dispose(): void {
        this.encoder = null
    }
}
