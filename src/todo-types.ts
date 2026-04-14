export type TodoStatus = "not-started" | "in-progress" | "completed"

export interface TodoItem {
    id: number
    title: string
    status: TodoStatus
}
