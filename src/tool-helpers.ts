/**
 * Shared tool execution utilities for agentic loops.
 *
 * Used by both Hammer CLI agent and Magic webapp agent for
 * consistent tool result truncation and safe execution wrapping.
 */

import type { ToolCall, ToolResult } from "./types"
import { formatToolCallAsUnixCommand } from "./unix-tooling"

// ---------------------------------------------------------------------------
// Tool result truncation
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

export interface TruncationResult {
    content: string
    truncated: boolean
    truncatedBy: "lines" | "bytes" | null
    totalLines: number
    totalBytes: number
    outputLines: number
    outputBytes: number
    lastLinePartial: boolean
    firstLineExceedsLimit: boolean
    maxLines: number
    maxBytes: number
}

export interface TruncationOptions {
    maxLines?: number
    maxBytes?: number
}

function splitLinesForCounting(content: string): string[] {
    if (content.length === 0) {
        return []
    }

    const lines = content.split("\n")
    if (content.endsWith("\n")) {
        lines.pop()
    }
    return lines
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(
    content: string,
    options: TruncationOptions = {},
): TruncationResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

    const totalBytes = utf8ByteLength(content)
    const lines = splitLinesForCounting(content)
    const totalLines = lines.length

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            truncated: false,
            truncatedBy: null,
            totalLines,
            totalBytes,
            outputLines: totalLines,
            outputBytes: totalBytes,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines,
            maxBytes,
        }
    }

    if (lines.length > 0 && utf8ByteLength(lines[0]) > maxBytes) {
        return {
            content: "",
            truncated: true,
            truncatedBy: "bytes",
            totalLines,
            totalBytes,
            outputLines: 0,
            outputBytes: 0,
            lastLinePartial: false,
            firstLineExceedsLimit: true,
            maxLines,
            maxBytes,
        }
    }

    const outputLinesArr: string[] = []
    let outputBytesCount = 0
    let truncatedBy: "lines" | "bytes" = "lines"

    for (let i = 0; i < lines.length && i < maxLines; i++) {
        const line = lines[i]
        const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0)
        if (outputBytesCount + lineBytes > maxBytes) {
            truncatedBy = "bytes"
            break
        }

        outputLinesArr.push(line)
        outputBytesCount += lineBytes
    }

    if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
        truncatedBy = "lines"
    }

    const outputContent = outputLinesArr.join("\n")
    const finalOutputBytes = utf8ByteLength(outputContent)

    return {
        content: outputContent,
        truncated: true,
        truncatedBy,
        totalLines,
        totalBytes,
        outputLines: outputLinesArr.length,
        outputBytes: finalOutputBytes,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines,
        maxBytes,
    }
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * May return partial first line if only tail bytes of the last line fit.
 */
export function truncateTail(
    content: string,
    options: TruncationOptions = {},
): TruncationResult {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

    const totalBytes = utf8ByteLength(content)
    const lines = splitLinesForCounting(content)
    const totalLines = lines.length

    if (totalLines <= maxLines && totalBytes <= maxBytes) {
        return {
            content,
            truncated: false,
            truncatedBy: null,
            totalLines,
            totalBytes,
            outputLines: totalLines,
            outputBytes: totalBytes,
            lastLinePartial: false,
            firstLineExceedsLimit: false,
            maxLines,
            maxBytes,
        }
    }

    const outputLinesArr: string[] = []
    let outputBytesCount = 0
    let truncatedBy: "lines" | "bytes" = "lines"
    let lastLinePartial = false

    for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
        const line = lines[i]
        const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0)

        if (outputBytesCount + lineBytes > maxBytes) {
            truncatedBy = "bytes"
            if (outputLinesArr.length === 0) {
                const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes)
                outputLinesArr.unshift(truncatedLine)
                outputBytesCount = utf8ByteLength(truncatedLine)
                lastLinePartial = true
            }
            break
        }

        outputLinesArr.unshift(line)
        outputBytesCount += lineBytes
    }

    if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
        truncatedBy = "lines"
    }

    const outputContent = outputLinesArr.join("\n")
    const finalOutputBytes = utf8ByteLength(outputContent)

    return {
        content: outputContent,
        truncated: true,
        truncatedBy,
        totalLines,
        totalBytes,
        outputLines: outputLinesArr.length,
        outputBytes: finalOutputBytes,
        lastLinePartial,
        firstLineExceedsLimit: false,
        maxLines,
        maxBytes,
    }
}

// ---------------------------------------------------------------------------
// Tool result presentation
// ---------------------------------------------------------------------------

export function formatToolResultMessage(
    toolCall: ToolCall,
    result: ToolResult,
): string {
    const exitCode = typeof result.exit_code === "number"
        ? result.exit_code
        : result.success === true
            ? 0
            : 1
    const durationMs = typeof result.duration_ms === "number"
        ? result.duration_ms
        : 0
    const command = typeof result.command === "string" && result.command.length > 0
        ? result.command
        : (() => {
            const unixCommand = formatToolCallAsUnixCommand(toolCall)
            if (unixCommand) {
                return unixCommand
            }

            const parts = [toolCall.name]
            for (const [name, value] of Object.entries(toolCall.parameters ?? {})) {
                if (value === undefined || value === null) {
                    continue
                }

                if (typeof value === "boolean") {
                    parts.push(value ? `--${name}` : `--no-${name}`)
                    continue
                }

                if (typeof value === "string" && !value.includes("\n") && !/\s/.test(value)) {
                    parts.push(`--${name}`, value)
                    continue
                }

                parts.push(`--${name}`, JSON.stringify(value))
            }

            return parts.join(" ")
        })()

    const stdout = truncatePresentationOutput(renderToolStdout(result), toolCall)
    const stderr = typeof result.stderr === "string" && result.stderr.length > 0
        ? result.stderr
        : exitCode !== 0 && typeof result.error === "string"
            ? result.error
            : ""
    const metaLine = (() => {
        const commandName = (result as ToolResult & { command_name?: unknown }).command_name
        const route = (result as ToolResult & { route?: unknown }).route
        const metadata: Record<string, string | number | boolean> = {
            tool: typeof commandName === "string" ? commandName : toolCall.name,
            route: typeof route === "string" ? route : toolCall.name,
        }

        for (const source of [toolCall.parameters ?? {}, result as Record<string, unknown>]) {
            for (const key of ["path", "url", "query", "taskId", "task_id", "pattern"]) {
                const value = source[key]
                if (typeof value === "string" && value.length > 0) {
                    metadata[key] = value
                }
            }
        }

        const pairs = Object.entries(metadata)
        if (pairs.length === 0) {
            return ""
        }

        return `[meta] ${pairs
            .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`)
            .join(" ")}`
    })()
    const lines = [`$ ${command}`]

    if (stdout) {
        lines.push(stdout)
    }

    if (stderr) {
        if (!stdout && exitCode !== 0 && !stderr.includes("\n")) {
            lines.push(`[error] ${stderr}`)
        } else {
            lines.push(`[stderr]\n${stderr}`)
        }
    }

    if (!stdout && !stderr && exitCode === 0) {
        lines.push("(no output)")
    }

    if (metaLine) {
        lines.push(metaLine)
    }

    const duration = durationMs >= 1000
        ? `${(durationMs / 1000).toFixed(1)}s`
        : `${Math.max(0, Math.round(durationMs))}ms`
    lines.push(`[exit:${exitCode} | ${duration}]`)
    return lines.join("\n")
}

export function parseToolResultMessage(content: string): {
    success: boolean
    toolName?: string
    error?: string
    parsed?: Record<string, any>
} {
    try {
        const parsed = JSON.parse(content)
        const toolName = typeof parsed.command_name === "string"
            ? parsed.command_name
            : typeof parsed.route === "string"
                ? parsed.route
                : typeof parsed.tool_name === "string"
                    ? parsed.tool_name
                    : typeof parsed.toolName === "string"
                        ? parsed.toolName
                        : typeof parsed.tool === "string"
                            ? parsed.tool
                            : typeof parsed.name === "string"
                                ? parsed.name
                : undefined
        return {
            success: parsed.success === true,
            toolName,
            error: parsed.error,
            parsed,
        }
    } catch {
        const lines = content.split(/\r?\n/)
        const commandLine = lines[0]?.startsWith("$ ") ? lines.shift()!.slice(2) : undefined

        const stdoutLines: string[] = []
        const stderrLines: string[] = []
        let errorLine: string | undefined
        let metaLine = ""
        let exitCode = 1
        let durationMs = 0
        let inStderr = false

        for (const line of lines) {
            if (line.startsWith("[stderr]")) {
                inStderr = true
                const inline = line.slice("[stderr]".length).trim()
                if (inline) {
                    stderrLines.push(inline)
                }
                continue
            }

            if (line.startsWith("[error] ")) {
                errorLine = line.slice("[error] ".length)
                inStderr = false
                continue
            }

            if (line.startsWith("[meta] ")) {
                metaLine = line.slice("[meta] ".length)
                inStderr = false
                continue
            }

            const exitMatch = line.match(/^\[exit:(-?\d+)\s*\|\s*([^\]]+)\]$/)
            if (exitMatch) {
                exitCode = Number(exitMatch[1])
                const rawDuration = exitMatch[2].trim().toLowerCase()
                if (rawDuration.endsWith("ms")) {
                    durationMs = Number(rawDuration.slice(0, -2)) || 0
                } else if (rawDuration.endsWith("s")) {
                    durationMs = Math.round((Number(rawDuration.slice(0, -1)) || 0) * 1000)
                } else {
                    durationMs = Number(rawDuration) || 0
                }
                inStderr = false
                continue
            }

            if (inStderr) {
                stderrLines.push(line)
            } else {
                stdoutLines.push(line)
            }
        }

        const metadata = (() => {
            if (!metaLine) {
                return {}
            }

            const values: Record<string, any> = {}
            const regex = /(\w+)=((?:"(?:[^"\\]|\\.)*")|\S+)/g
            let match: RegExpExecArray | null
            while ((match = regex.exec(metaLine)) !== null) {
                const key = match[1]
                const rawValue = match[2]
                if (rawValue.startsWith('"')) {
                    try {
                        values[key] = JSON.parse(rawValue)
                    } catch {
                        values[key] = rawValue.slice(1, -1)
                    }
                    continue
                }

                if (rawValue === "true") {
                    values[key] = true
                } else if (rawValue === "false") {
                    values[key] = false
                } else if (!Number.isNaN(Number(rawValue))) {
                    values[key] = Number(rawValue)
                } else {
                    values[key] = rawValue
                }
            }

            return values
        })()
        const stdout = stdoutLines.join("\n").trim()
        const stderr = stderrLines.join("\n").trim()
        const error = errorLine ?? (exitCode === 0 ? undefined : stderr || undefined)
        const parsed = {
            success: exitCode === 0,
            command: commandLine,
            output: stdout,
            stderr,
            error,
            exit_code: exitCode,
            duration_ms: durationMs,
            ...metadata,
        }

        return {
            success: exitCode === 0,
            toolName:
                typeof metadata.tool === "string"
                    ? metadata.tool
                    : typeof metadata.route === "string"
                        ? metadata.route
                        : undefined,
            error,
            parsed,
        }
    }
}

// ---------------------------------------------------------------------------
// Safe tool execution
// ---------------------------------------------------------------------------

/**
 * Execute a tool call with standard error handling.
 * Catches any thrown error and returns `{ success: false, error: message }`.
 */
export async function executeToolSafe(
    fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
    try {
        return await fn()
    } catch (err: unknown) {
        return {
            success: false,
            error: err instanceof Error ? err.message : "Tool execution failed",
        }
    }
}

function renderToolStdout(result: ToolResult): string {
    if (typeof result.stdout === "string") {
        return result.stdout
    }

    if (typeof result.output === "string") {
        return result.output
    }

    if (typeof result.content === "string") {
        return result.content
    }

    if (typeof result.data === "string") {
        return result.data
    }

    const matchEntries = (result as ToolResult & { matches?: unknown[] }).matches
    if (Array.isArray(matchEntries)) {
        return matchEntries
            .map((match) => {
                if (typeof match === "string") return match
                if (!match || typeof match !== "object") return JSON.stringify(match)

                const typed = match as {
                    file?: unknown
                    line?: unknown
                    content?: unknown
                }
                const file = typeof typed.file === "string" ? typed.file : ""
                const line = typeof typed.line === "number" ? typed.line : ""
                const content = typeof typed.content === "string"
                    ? typed.content
                    : JSON.stringify(match)
                return `${file}${line ? `:${line}` : ""}: ${content}`.trim()
            })
            .join("\n")
    }

    for (const candidate of [result.output, result.content, result.data]) {
        if (candidate && typeof candidate === "object") {
            return JSON.stringify(candidate, null, 2)
        }
    }

    const {
        success: _success,
        error: _error,
        stderr: _stderr,
        exit_code: _exitCode,
        duration_ms: _durationMs,
        command: _command,
        ...remainder
    } = result
    if (Object.keys(remainder).length === 0) {
        return ""
    }

    return JSON.stringify(remainder, null, 2)
}

function truncatePresentationOutput(output: string, toolCall: ToolCall): string {
    if (!output) {
        return ""
    }

    const isBash = isBashLikeToolCall(toolCall)
    const truncation = isBash
        ? truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
        : truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })

    if (!truncation.truncated) {
        return output
    }

    const suffix = buildTruncationNotice(toolCall, truncation)
    if (!suffix) {
        return truncation.content
    }

    if (!truncation.content) {
        return suffix
    }

    return `${truncation.content}\n\n${suffix}`
}

function buildTruncationNotice(toolCall: ToolCall, truncation: TruncationResult): string {
    const kind = (() => {
        if (isBashLikeToolCall(toolCall)) {
            return "bash" as const
        }

        const normalized = toolCall.name.toLowerCase()
        if (normalized.includes("read")) return "read" as const
        if (normalized === "ls" || normalized.includes("list")) return "ls" as const
        if (normalized.includes("grep") || normalized.includes("search")) return "grep" as const
        if (normalized.includes("find")) return "find" as const
        return "default" as const
    })()

    if (kind === "read") {
        if (truncation.firstLineExceedsLimit) {
            return `[Line 1 exceeds ${formatSize(truncation.maxBytes)} limit. Use bash to read a bounded byte range.]`
        }

        const endLine = Math.max(0, truncation.outputLines)
        const nextOffset = endLine + 1
        if (truncation.truncatedBy === "lines") {
            return `[Showing lines 1-${endLine} of ${truncation.totalLines}. Use offset=${nextOffset} to continue.]`
        }
        return `[Showing lines 1-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Use offset=${nextOffset} to continue.]`
    }

    if (kind === "bash") {
        const startLine = truncation.totalLines - truncation.outputLines + 1
        const endLine = truncation.totalLines
        if (truncation.lastLinePartial) {
            return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line exceeds ${formatSize(truncation.maxBytes)}).]`
        }
        if (truncation.truncatedBy === "lines") {
            return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.]`
        }
        return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit).]`
    }

    if (kind === "grep") {
        return `[${formatSize(truncation.maxBytes)} limit reached. Refine pattern or narrow path.]`
    }

    if (kind === "find") {
        return `[${formatSize(truncation.maxBytes)} limit reached. Refine pattern or increase limit.]`
    }

    if (kind === "ls") {
        return `[${formatSize(truncation.maxBytes)} limit reached. Use a narrower path.]`
    }

    return `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`
}

function isBashLikeToolCall(toolCall: ToolCall): boolean {
    if (toolCall.kind === "bash" || toolCall.kind === "background_bash") {
        return true
    }

    const normalized = toolCall.name.toLowerCase()
    return normalized === "bash" || normalized === "backgroundbash"
}

function utf8ByteLength(text: string): number {
    if (!text) {
        return 0
    }

    return new TextEncoder().encode(text).length
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
    if (maxBytes <= 0) return ""

    let outputBytes = 0
    let start = str.length
    for (let i = str.length; i > 0;) {
        let characterStart = i - 1
        const code = str.charCodeAt(characterStart)
        let characterBytes: number

        if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
            const previous = str.charCodeAt(characterStart - 1)
            if (previous >= 0xd800 && previous <= 0xdbff) {
                characterStart--
                characterBytes = 4
            } else {
                characterBytes = 3
            }
        } else if (code >= 0xd800 && code <= 0xdbff) {
            characterBytes = 3
        } else {
            characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
        }

        if (outputBytes + characterBytes > maxBytes) break
        outputBytes += characterBytes
        start = characterStart
        i = characterStart
    }

    return str.slice(start)
}

function formatSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes}B`
    }

    const kb = bytes / 1024
    if (kb < 1024) {
        return `${kb.toFixed(1)}KB`
    }

    const mb = kb / 1024
    return `${mb.toFixed(1)}MB`
}


