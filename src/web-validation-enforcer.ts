/**
 * WebValidationEnforcer — shared subclass of BaseValidationEnforcer
 * for browser-based agents (Magic webapp, future web agents).
 *
 * Provides:
 *  • Missing tool-call warning (non-terminal response without an executable control segment)
 *  • API error surfacing
 *  • Browser-compatible logging (no chalk, no file I/O)
 *
 * Unlike Hammer's ValidationEnforcer, this does NOT include:
 *  • ListSkills/ReadSkill-first enforcement (no skills concept in web)
 *  • Init error handlers (web agents use simpler init flow)
 *  • File system session persistence
 */

import {
    BaseValidationEnforcer,
    type ConversationSink,
} from "./validation-enforcer"

/**
 * WebValidationEnforcer — lightweight validation enforcement for
 * browser-based agents.
 *
 * Wire up with `createConversationSink(...)` against the underlying
 * message store:
 * ```ts
 * const sink = createConversationSink((role, content) =>
 *     memory.appendMessage(role, content)
 * )
 * const enforcer = new WebValidationEnforcer(sink)
 * ```
 */
export class WebValidationEnforcer extends BaseValidationEnforcer {
    /** Optional callback for logging (default: console). */
    private onLog?: (level: "warn" | "error", message: string) => void

    constructor(
        sink: ConversationSink,
        opts?: { onLog?: (level: "warn" | "error", message: string) => void },
    ) {
        super(sink)
        this.onLog = opts?.onLog
    }

    // ── Protected overrides ──────────────────────────────────────────

    protected override logWarning(message: string): void {
        if (this.onLog) {
            this.onLog("warn", message)
        } else {
            console.warn(`[Agent] ⚠ ${message}`)
        }
    }

    protected override logError(message: string): void {
        if (this.onLog) {
            this.onLog("error", message)
        } else {
            console.error(`[Agent] ${message}`)
        }
    }

    protected override async surfaceValidationContext(error: Error): Promise<void> {
        const rawContent = this.readValidationRawContent(error)
        if (!rawContent) {
            return
        }

        await this.sink.addMessage("assistant", rawContent)
    }
}
