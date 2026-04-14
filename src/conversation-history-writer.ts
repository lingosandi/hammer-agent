/**
 * Shared conversation history utilities.
 *
 * Provides:
 * - `atomicWriteJSON()` — crash-safe file writing (tmp + rename)
 * - `ConversationHistoryEntry` — debug-friendly message format
 * - `formatConversationHistory()` — converts MemoryMessages to debug entries
 *
 * Used by:
 * - Voice agent (Bun server writes conversation_history.json alongside voice-memory.json)
 * - Hammer agent (ConversationManager, UnifiedAgent)
 *
 * NOTE: Server-only module (requires Node/Bun fs). Not imported by browser/mobile code.
 */

/// <reference types="node" />

import { writeFile, rename, mkdir } from "fs/promises"
import { dirname } from "path"
import type { MemoryMessage } from "./memory-layer"

// ============================================================================
// Atomic File Writing
// ============================================================================

/**
 * Atomically write JSON data to a file using tmp + rename.
 *
 * 1. Creates parent directories if needed
 * 2. Writes to `filePath.tmp`
 * 3. Renames to `filePath` (atomic on most filesystems)
 *
 * Prevents data corruption if the process crashes mid-write.
 */
export async function atomicWriteJSON(
    filePath: string,
    data: unknown,
): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const tmpFile = filePath + ".tmp"
    await writeFile(tmpFile, JSON.stringify(data, null, 2), "utf-8")
    await rename(tmpFile, filePath)
}

// ============================================================================
// Conversation History
// ============================================================================

/** Debug-friendly conversation history entry. */
export interface ConversationHistoryEntry {
    turn: number
    role: string
    content: string
    timestamp: number
    id?: string
    tokenCount?: number
}

/**
 * Convert raw MemoryMessages to a flat, debug-friendly array.
 *
 * The output is designed for easy reading in a JSON viewer — no nested
 * compressed-state or cursor objects. Each entry is one message with
 * its turn number, role, content, and timestamp.
 */
export function formatConversationHistory(
    messages: MemoryMessage[],
): ConversationHistoryEntry[] {
    return messages.map((m) => ({
        turn: m.turn,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.id ? { id: m.id } : {}),
        ...(m.tokenCount ? { tokenCount: m.tokenCount } : {}),
    }))
}
