export type RuntimeSubscriber = () => void

export type RuntimeSnapshotUpdater<TSnapshot> =
    | TSnapshot
    | ((current: TSnapshot) => TSnapshot)

export interface RuntimeStore<TSnapshot> {
    subscribe: (subscriber: RuntimeSubscriber) => () => void
    getSnapshot: () => TSnapshot
    getServerSnapshot: () => TSnapshot
    setSnapshot: (updater: RuntimeSnapshotUpdater<TSnapshot>) => TSnapshot
    resetSnapshot: () => TSnapshot
}

export interface RuntimeController<
    TSnapshot,
    TActions extends Record<string, unknown>,
    TRefs extends Record<string, unknown> = {},
> {
    store: RuntimeStore<TSnapshot>
    actions: TActions
    refs: TRefs
}

export function createRuntimeStore<TSnapshot>(
    createInitialSnapshot: () => TSnapshot,
): RuntimeStore<TSnapshot> {
    let snapshot = createInitialSnapshot()
    const subscribers = new Set<RuntimeSubscriber>()

    const notifySubscribers = () => {
        for (const subscriber of subscribers) {
            subscriber()
        }
    }

    return {
        subscribe(subscriber) {
            subscribers.add(subscriber)
            return () => {
                subscribers.delete(subscriber)
            }
        },
        getSnapshot() {
            return snapshot
        },
        getServerSnapshot() {
            return snapshot
        },
        setSnapshot(updater) {
            snapshot = typeof updater === "function"
                ? (updater as (current: TSnapshot) => TSnapshot)(snapshot)
                : updater
            notifySubscribers()
            return snapshot
        },
        resetSnapshot() {
            snapshot = createInitialSnapshot()
            notifySubscribers()
            return snapshot
        },
    }
}

export function defineRuntimeController<
    TSnapshot,
    TActions extends Record<string, unknown>,
    TRefs extends Record<string, unknown> = {},
>(
    controller: RuntimeController<TSnapshot, TActions, TRefs>,
): RuntimeController<TSnapshot, TActions, TRefs> {
    return controller
}