/**
 * hammer-agent/node — Node.js-specific utilities.
 *
 * Import from "hammer-agent/node" in CLI or server environments.
 * Do NOT import this in browser or React app-router code.
 *
 * @example
 * import { TiktokenEstimator } from 'hammer-agent/node'
 */

// Precise token counting with tiktoken (requires optional peer dep: tiktoken)
export { TiktokenEstimator } from "./tiktoken-estimator"

// Crash-safe conversation history file I/O
export {
    atomicWriteJSON,
    formatConversationHistory,
    type ConversationHistoryEntry,
} from "./conversation-history-writer"
