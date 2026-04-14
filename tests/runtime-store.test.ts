import { describe, expect, test } from "vitest"

import {
    createRuntimeStore,
    defineRuntimeController,
    type RuntimeController,
} from "../src/runtime-store"

describe("runtime-store", () => {
    test("notifies subscribers when snapshot changes and when reset", () => {
        const store = createRuntimeStore(() => ({ count: 0, label: "idle" }))
        const seen: Array<{ count: number; label: string }> = []

        const unsubscribe = store.subscribe(() => {
            seen.push(store.getSnapshot())
        })

        const afterSet = store.setSnapshot((current) => ({
            ...current,
            count: current.count + 1,
            label: "running",
        }))

        expect(afterSet).toEqual({ count: 1, label: "running" })
        expect(store.getSnapshot()).toEqual({ count: 1, label: "running" })
        expect(store.getServerSnapshot()).toEqual({ count: 1, label: "running" })

        const afterReset = store.resetSnapshot()

        expect(afterReset).toEqual({ count: 0, label: "idle" })
        expect(seen).toEqual([
            { count: 1, label: "running" },
            { count: 0, label: "idle" },
        ])

        unsubscribe()
        store.setSnapshot({ count: 2, label: "done" })
        expect(seen).toHaveLength(2)
    })

    test("defineRuntimeController preserves store actions and refs", () => {
        const store = createRuntimeStore(() => ({ ready: false }))
        const run = () => "ran"
        const refs = { current: 123 }

        const controller = defineRuntimeController({
            store,
            actions: { run },
            refs,
        }) satisfies RuntimeController<
            { ready: boolean },
            { run: () => string },
            { current: number }
        >

        expect(controller.store.getSnapshot()).toEqual({ ready: false })
        expect(controller.actions.run()).toBe("ran")
        expect(controller.refs.current).toBe(123)
    })
})
