import { describe, expect, test } from "vitest"
import { createActor } from "xstate"
import { LLMResponseSchema } from "../src/schemas"
import {
    agentMachine,
    AGENT_MACHINE_STATES,
    type AgentMachineState,
    type AgentMachineContext,
    type AgentMachineEvent,
    type TruncatedToolInfo,
} from "../src/agent-machine"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh actor, send a sequence of events, return final snapshot. */
function runSequence(events: AgentMachineEvent[]) {
    const actor = createActor(agentMachine)
    actor.start()
    for (const event of events) {
        actor.send(event)
    }
    const snap = actor.getSnapshot()
    actor.stop()
    return snap
}

/** Shortcut: get state value from snapshot. */
function getState(events: AgentMachineEvent[]): AgentMachineState {
    return runSequence(events).value as AgentMachineState
}

/** Shortcut: get context from snapshot. */
function getContext(events: AgentMachineEvent[]): AgentMachineContext {
    return runSequence(events).context
}

// ---------------------------------------------------------------------------
// AGENT_MACHINE_STATES constant
// ---------------------------------------------------------------------------

describe("AGENT_MACHINE_STATES", () => {
    test("contains all 7 states", () => {
        expect(AGENT_MACHINE_STATES).toHaveLength(7)
    })

    test("contains expected state names", () => {
        expect(AGENT_MACHINE_STATES).toContain("idle")
        expect(AGENT_MACHINE_STATES).toContain("prompting")
        expect(AGENT_MACHINE_STATES).toContain("analyzing")
        expect(AGENT_MACHINE_STATES).toContain("executing")
        expect(AGENT_MACHINE_STATES).toContain("updating")
        expect(AGENT_MACHINE_STATES).toContain("done")
        expect(AGENT_MACHINE_STATES).toContain("failed")
    })

    test("is a readonly array (TypeScript enforces immutability)", () => {
        // `as const` makes it readonly at the type level, not runtime-frozen
        expect(Array.isArray(AGENT_MACHINE_STATES)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Default context
// ---------------------------------------------------------------------------

describe("Default context", () => {
    test("initial state is idle", () => {
        const actor = createActor(agentMachine)
        actor.start()
        expect(actor.getSnapshot().value).toBe("idle")
        actor.stop()
    })

    test("default context values are correct", () => {
        const actor = createActor(agentMachine)
        actor.start()
        const ctx = actor.getSnapshot().context
        expect(ctx.task).toBe("")
        expect(ctx.actionCount).toBe(0)
        expect(ctx.truncatedToolInfo).toBeUndefined()
        expect(ctx.lastToolResult).toBeUndefined()
        expect(ctx.error).toBeUndefined()
        expect(ctx.finalOutcome).toBe("running")
        expect(ctx.hasCalledListSkills).toBe(false)
        actor.stop()
    })
})

// ---------------------------------------------------------------------------
// Happy path: full lifecycle
// ---------------------------------------------------------------------------

describe("Happy path lifecycle", () => {
    test("idle → START → prompting", () => {
        expect(getState([
            { type: "START", task: "Build a website" },
        ])).toBe("prompting")
    })

    test("START sets task and actionCount", () => {
        const ctx = getContext([
            { type: "START", task: "Build a website", actionCount: 5 },
        ])
        expect(ctx.task).toBe("Build a website")
        expect(ctx.actionCount).toBe(5)
        expect(ctx.finalOutcome).toBe("running")
    })

    test("START defaults actionCount=0", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
        ])
        expect(ctx.actionCount).toBe(0)
    })

    test("prompting → PROMPT_COMPLETE → analyzing (increments actionCount)", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
        ])
        expect(ctx.actionCount).toBe(1)
    })

    test("state is analyzing after PROMPT_COMPLETE", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
        ])).toBe("analyzing")
    })

    test("analyzing → LLM_SUCCESS → executing", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
        ])).toBe("executing")
    })

    test("executing → TOOLS_EXECUTED → updating", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED" },
        ])).toBe("updating")
    })

    test("TOOLS_EXECUTED stores lastToolResult", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED", lastToolResult: '{"success":true}' },
        ])
        expect(ctx.lastToolResult).toBe('{"success":true}')
    })

    test("updating → UPDATE_COMPLETE → prompting", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED" },
            { type: "UPDATE_COMPLETE" },
        ])).toBe("prompting")
    })

    test("full loop: idle → prompting → analyzing → executing → updating → prompting → done", () => {
        const state = getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED" },
            { type: "UPDATE_COMPLETE" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])
        expect(state).toBe("done")
    })

    test("actionCount increments each PROMPT_COMPLETE", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED" },
            { type: "UPDATE_COMPLETE" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED" },
            { type: "UPDATE_COMPLETE" },
            { type: "PROMPT_COMPLETE" },
        ])
        expect(ctx.actionCount).toBe(3)
    })
})

// ---------------------------------------------------------------------------
// OUTCOME_SUCCESS (from analyzing or executing)
// ---------------------------------------------------------------------------

describe("OUTCOME_SUCCESS", () => {
    test("from analyzing → done", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])).toBe("done")
    })

    test("from executing → done", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "OUTCOME_SUCCESS" },
        ])).toBe("done")
    })

    test("sets finalOutcome = 'success'", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])
        expect(ctx.finalOutcome).toBe("success")
    })

    test("done is a final state (machine status is 'done')", () => {
        const snap = runSequence([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])
        expect(snap.status).toBe("done")
    })
})

// ---------------------------------------------------------------------------
// OUTCOME_FAILURE
// ---------------------------------------------------------------------------

describe("OUTCOME_FAILURE", () => {
    test("from analyzing → failed", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_FAILURE", error: "Out of options" },
        ])).toBe("failed")
    })

    test("from executing → failed", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "OUTCOME_FAILURE", error: "Can't proceed" },
        ])).toBe("failed")
    })

    test("sets finalOutcome = 'failure' and error", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_FAILURE", error: "Stuck" },
        ])
        expect(ctx.finalOutcome).toBe("failure")
        expect(ctx.error).toBe("Stuck")
    })

    test("failed is a final state", () => {
        const snap = runSequence([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_FAILURE" },
        ])
        expect(snap.status).toBe("done") // XState uses "done" status for final states
    })

    test("OUTCOME_FAILURE without error sets undefined error", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_FAILURE" },
        ])
        expect(ctx.finalOutcome).toBe("failure")
        expect(ctx.error).toBeUndefined()
    })
})

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("Error paths", () => {
    test("LLM_VALIDATION_ERROR → prompting (retry)", () => {
        const state = getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_VALIDATION_ERROR", error: "Invalid JSON" },
        ])
        expect(state).toBe("prompting")
    })

    test("LLM_VALIDATION_ERROR stores error", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_VALIDATION_ERROR", error: "Missing outcome field" },
        ])
        expect(ctx.error).toBe("Missing outcome field")
    })

    test("LLM_API_ERROR → prompting (retry)", () => {
        const state = getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_API_ERROR", error: "429 rate limited" },
        ])
        expect(state).toBe("prompting")
    })

    test("LLM_API_ERROR stores error", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_API_ERROR", error: "500 server error" },
        ])
        expect(ctx.error).toBe("500 server error")
    })

    test("consecutive validation errors stay in prompting loop", () => {
        const state = getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_VALIDATION_ERROR", error: "err1" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_VALIDATION_ERROR", error: "err2" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_VALIDATION_ERROR", error: "err3" },
        ])
        expect(state).toBe("prompting")
    })
})

// ---------------------------------------------------------------------------
// ENFORCEMENT_BREAK (from executing → prompting)
// ---------------------------------------------------------------------------

describe("ENFORCEMENT_BREAK", () => {
    test("executing → prompting", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "ENFORCEMENT_BREAK", lastToolResult: "skipped" },
        ])).toBe("prompting")
    })

    test("stores lastToolResult", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "ENFORCEMENT_BREAK", lastToolResult: '{"skipped":"ListSkills"}' },
        ])
        expect(ctx.lastToolResult).toBe('{"skipped":"ListSkills"}')
    })
})

// ---------------------------------------------------------------------------
// NO_TOOLS (from executing → prompting)
// ---------------------------------------------------------------------------

describe("NO_TOOLS", () => {
    test("executing → prompting", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "NO_TOOLS" },
        ])).toBe("prompting")
    })
})

// ---------------------------------------------------------------------------
// Global events (can be sent from any state)
// ---------------------------------------------------------------------------

describe("Global events", () => {
    test("SET_TRUNCATION sets truncatedToolInfo", () => {
        const info: TruncatedToolInfo = { name: "Write", filePath: "/test.ts", executionSucceeded: true }
        const ctx = getContext([
            { type: "SET_TRUNCATION", info },
        ])
        expect(ctx.truncatedToolInfo).toEqual(info)
    })

    test("SET_TRUNCATION with undefined clears truncatedToolInfo", () => {
        const info: TruncatedToolInfo = { name: "Write", executionSucceeded: false }
        const ctx = getContext([
            { type: "SET_TRUNCATION", info },
            { type: "SET_TRUNCATION", info: undefined },
        ])
        expect(ctx.truncatedToolInfo).toBeUndefined()
    })

    test("RESTORE_CONTEXT merges partial context", () => {
        const ctx = getContext([
            { type: "START", task: "original" },
            { type: "RESTORE_CONTEXT", context: {
                actionCount: 10,
                lastToolResult: "restored",
                hasCalledListSkills: true,
            }},
        ])
        expect(ctx.actionCount).toBe(10)
        expect(ctx.lastToolResult).toBe("restored")
        expect(ctx.hasCalledListSkills).toBe(true)
        expect(ctx.task).toBe("original") // unchanged
    })

    test("RESTORE_CONTEXT preserves unmentioned fields", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "RESTORE_CONTEXT", context: { actionCount: 7 } },
        ])
        expect(ctx.task).toBe("test")
        expect(ctx.actionCount).toBe(7)
    })

    test("SET_TRUNCATION works from idle state", () => {
        const info: TruncatedToolInfo = { name: "Edit", executionSucceeded: true }
        const ctx = getContext([{ type: "SET_TRUNCATION", info }])
        expect(ctx.truncatedToolInfo).toEqual(info)
    })

})

// ---------------------------------------------------------------------------
// Invalid events (events not accepted in current state)
// ---------------------------------------------------------------------------

describe("Invalid events are ignored", () => {
    test("PROMPT_COMPLETE from idle stays idle", () => {
        expect(getState([{ type: "PROMPT_COMPLETE" }])).toBe("idle")
    })

    test("LLM_SUCCESS from idle stays idle", () => {
        expect(getState([{ type: "LLM_SUCCESS" }])).toBe("idle")
    })

    test("TOOLS_EXECUTED from prompting stays prompting", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "TOOLS_EXECUTED" },
        ])).toBe("prompting")
    })

    test("UPDATE_COMPLETE from analyzing stays analyzing", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "UPDATE_COMPLETE" },
        ])).toBe("analyzing")
    })

    test("START from prompting stays prompting", () => {
        expect(getState([
            { type: "START", task: "test" },
            { type: "START", task: "override" },
        ])).toBe("prompting")
    })
})

// ---------------------------------------------------------------------------
// Multi-iteration with varying paths
// ---------------------------------------------------------------------------

describe("Multi-iteration scenarios", () => {
    test("recover from validation error then success", () => {
        const state = getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_VALIDATION_ERROR", error: "bad JSON" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "NO_TOOLS" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED" },
            { type: "UPDATE_COMPLETE" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])
        expect(state).toBe("done")
    })

    test("recover from API error then success", () => {
        const state = getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_API_ERROR", error: "timeout" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])
        expect(state).toBe("done")
    })

    test("enforcement break then continue to completion", () => {
        const state = getState([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "ENFORCEMENT_BREAK", lastToolResult: "blocked" },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])
        expect(state).toBe("done")
    })
})

// ---------------------------------------------------------------------------
// Context mutation correctness
// ---------------------------------------------------------------------------

describe("Context mutation correctness", () => {
    test("START clears error from previous run", () => {
        const ctx = getContext([
            { type: "RESTORE_CONTEXT", context: { error: "old error" } },
            { type: "START", task: "fresh start" },
        ])
        expect(ctx.error).toBeUndefined()
    })

    test("START resets finalOutcome to 'running'", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
        ])
        expect(ctx.finalOutcome).toBe("running")
    })

    test("TOOLS_EXECUTED without lastToolResult leaves it undefined", () => {
        const ctx = getContext([
            { type: "START", task: "test" },
            { type: "PROMPT_COMPLETE" },
            { type: "LLM_SUCCESS" },
            { type: "TOOLS_EXECUTED" },
        ])
        expect(ctx.lastToolResult).toBeUndefined()
    })

    test("multiple RESTORE_CONTEXT calls accumulate", () => {
        const ctx = getContext([
            { type: "RESTORE_CONTEXT", context: { actionCount: 5 } },
            { type: "RESTORE_CONTEXT", context: { hasCalledListSkills: true } },
        ])
        expect(ctx.actionCount).toBe(5)
        expect(ctx.hasCalledListSkills).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Machine shape verification
// ---------------------------------------------------------------------------

describe("Machine shape", () => {
    test("machine has id 'agent'", () => {
        expect(agentMachine.id).toBe("agent")
    })

    test("machine initial state is 'idle'", () => {
        const actor = createActor(agentMachine)
        actor.start()
        expect(actor.getSnapshot().value).toBe("idle")
        actor.stop()
    })
})

// ---------------------------------------------------------------------------
// Updating state escape hatches (round 2 additions)
// ---------------------------------------------------------------------------

describe("Updating state transitions", () => {
    const TO_UPDATING: AgentMachineEvent[] = [
        { type: "START", task: "test", actionCount: 0 },
        { type: "PROMPT_COMPLETE" },
        { type: "LLM_SUCCESS" },
        { type: "TOOLS_EXECUTED", lastToolResult: "result" },
    ]

    test("updating → UPDATE_COMPLETE → prompting", () => {
        expect(getState([...TO_UPDATING, { type: "UPDATE_COMPLETE" }])).toBe("prompting")
    })

    test("updating → OUTCOME_FAILURE → failed", () => {
        expect(getState([...TO_UPDATING, { type: "OUTCOME_FAILURE", error: "abort" }])).toBe("failed")
    })

    test("OUTCOME_FAILURE from updating sets error and finalOutcome", () => {
        const ctx = getContext([...TO_UPDATING, { type: "OUTCOME_FAILURE", error: "user aborted" }])
        expect(ctx.finalOutcome).toBe("failure")
        expect(ctx.error).toBe("user aborted")
    })

    test("updating → OUTCOME_SUCCESS → done", () => {
        expect(getState([...TO_UPDATING, { type: "OUTCOME_SUCCESS" }])).toBe("done")
    })

    test("OUTCOME_SUCCESS from updating sets finalOutcome", () => {
        const ctx = getContext([...TO_UPDATING, { type: "OUTCOME_SUCCESS" }])
        expect(ctx.finalOutcome).toBe("success")
    })

    test("invalid events stay in updating", () => {
        // These events should NOT transition out of updating
        expect(getState([...TO_UPDATING, { type: "PROMPT_COMPLETE" }])).toBe("updating")
        expect(getState([...TO_UPDATING, { type: "LLM_SUCCESS" }])).toBe("updating")
        expect(getState([...TO_UPDATING, { type: "START", task: "x", actionCount: 0 }])).toBe("updating")
    })
})

// ---------------------------------------------------------------------------
// Schema outcome case-insensitivity (validates schemas.ts preprocess)
// ---------------------------------------------------------------------------

describe("Outcome field case-insensitivity", () => {
    // Import the schema to test preprocessing
    test("lowercase outcome passes", async () => {
        const result = LLMResponseSchema.safeParse({
            outcome: "continue",
            reasoning: "test",
        })
        expect(result.success).toBe(true)
    })

    test("uppercase outcome is normalized", async () => {
        const result = LLMResponseSchema.safeParse({
            outcome: "Continue",
            reasoning: "test",
        })
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.data.outcome).toBe("continue")
        }
    })

    test("mixed case outcome is normalized", async () => {
        const result = LLMResponseSchema.safeParse({
            outcome: "SUCCESS",
            reasoning: "test",
        })
        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.data.outcome).toBe("success")
        }
    })

    test("invalid outcome still fails", async () => {
        const result = LLMResponseSchema.safeParse({
            outcome: "maybe",
            reasoning: "test",
        })
        expect(result.success).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// Actor lifecycle: start after final state
// ---------------------------------------------------------------------------

describe("Actor lifecycle", () => {
    test("new actor works after previous reaches done", () => {
        const snap1 = runSequence([
            { type: "START", task: "first", actionCount: 0 },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_SUCCESS" },
        ])
        expect(snap1.value).toBe("done")
        expect(snap1.status).toBe("done")

        const snap2 = runSequence([
            { type: "START", task: "second", actionCount: 0 },
        ])
        expect(snap2.value).toBe("prompting")
        expect(snap2.context.task).toBe("second")
    })

    test("new actor works after previous reaches failed", () => {
        const snap1 = runSequence([
            { type: "START", task: "first", actionCount: 0 },
            { type: "PROMPT_COMPLETE" },
            { type: "OUTCOME_FAILURE", error: "oops" },
        ])
        expect(snap1.status).toBe("done") // XState "done" status for final states

        const snap2 = runSequence([
            { type: "START", task: "again", actionCount: 0 },
        ])
        expect(snap2.value).toBe("prompting")
        expect(snap2.context.task).toBe("again")
    })
})
