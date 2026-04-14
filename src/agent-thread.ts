export const DEFAULT_THREAD_AUTO_SCROLL_BOTTOM_THRESHOLD = 24

export type ScrollMetrics = {
    scrollHeight: number
    scrollTop: number
    clientHeight: number
}

export function getDistanceFromBottom({
    scrollHeight,
    scrollTop,
    clientHeight,
}: ScrollMetrics): number {
    return scrollHeight - scrollTop - clientHeight
}

export function shouldAutoScrollThread(
    scrollMetrics: ScrollMetrics,
    threshold = DEFAULT_THREAD_AUTO_SCROLL_BOTTOM_THRESHOLD,
): boolean {
    return getDistanceFromBottom(scrollMetrics) <= threshold
}

export function getToolLogSummaryLine(content: string): string {
    for (const line of content.split(/\r?\n/)) {
        if (line.trim().length > 0) {
            return line
        }
    }

    return ""
}

export function stripDiagnosticMessagePrefix(content: string): string {
    return content.replace(/^⚠️\s+(?:ERROR|WARNING):\s*/, "")
}

export function getDiagnosticSummaryLine(content: string): string {
    const strippedContent = stripDiagnosticMessagePrefix(content)
    const summaryLine = getToolLogSummaryLine(strippedContent)

    return summaryLine.length > 0 ? summaryLine : getToolLogSummaryLine(content)
}

export function buildToolLogRevealFrames(
    content: string,
    targetFrameCount = 40,
): string[] {
    if (content.length === 0) {
        return [""]
    }

    const sanitizedTargetFrameCount = Math.max(1, targetFrameCount)
    const targetCharsPerFrame = Math.max(
        1,
        Math.ceil(content.length / sanitizedTargetFrameCount),
    )
    const segments = mergeStructuralToolLogSegments(
        splitToolLogRevealSegments(content),
    )
    const frames: string[] = []
    let pendingFrame = ""
    let revealedContent = ""

    for (const segment of segments) {
        if (
            pendingFrame.length > 0
            && pendingFrame.length + segment.length > targetCharsPerFrame
        ) {
            revealedContent += pendingFrame
            frames.push(revealedContent)
            pendingFrame = ""
        }

        pendingFrame += segment

        if (pendingFrame.length >= targetCharsPerFrame) {
            revealedContent += pendingFrame
            frames.push(revealedContent)
            pendingFrame = ""
        }
    }

    if (pendingFrame.length > 0) {
        revealedContent += pendingFrame
        frames.push(revealedContent)
    }

    if (frames.length === 0 || frames.at(-1) !== content) {
        frames.push(content)
    }

    return frames
}

function mergeStructuralToolLogSegments(segments: string[]): string[] {
    const mergedSegments: string[] = []

    for (const segment of segments) {
        const previousSegment = mergedSegments.at(-1)

        if (previousSegment && shouldMergeToolLogSegmentWithFollowing(previousSegment)) {
            mergedSegments[mergedSegments.length - 1] = previousSegment + segment
            continue
        }

        mergedSegments.push(segment)
    }

    return mergedSegments
}

function shouldMergeToolLogSegmentWithFollowing(segment: string): boolean {
    const trimmedSegment = segment.trim()

    if (trimmedSegment.length === 0) {
        return true
    }

    if (segment.startsWith("$ ")) {
        return true
    }

    return (
        trimmedSegment === "{"
        || trimmedSegment === "["
        || trimmedSegment.endsWith("{")
        || trimmedSegment.endsWith("[")
    )
}

function splitToolLogRevealSegments(content: string): string[] {
    const segments: string[] = []
    let currentSegment = ""
    let inQuotedString = false
    let isEscaped = false

    for (const character of content) {
        currentSegment += character

        if (inQuotedString) {
            if (isEscaped) {
                isEscaped = false
                continue
            }

            if (character === "\\") {
                isEscaped = true
                continue
            }

            if (character === '"') {
                inQuotedString = false
            }

            continue
        }

        if (character === '"') {
            inQuotedString = true
            continue
        }

        if (
            character === "\n"
            || character === ","
            || character === "}"
            || character === "]"
        ) {
            segments.push(currentSegment)
            currentSegment = ""
        }
    }

    if (currentSegment.length > 0) {
        segments.push(currentSegment)
    }

    return segments.length > 0 ? segments : [content]
}