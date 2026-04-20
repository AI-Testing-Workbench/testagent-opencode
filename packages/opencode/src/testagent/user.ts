// testagent - new file
// Stores the current user ID set by the VS Code extension via HTTP.

let current: string | undefined

export const User = {
  get(): string | undefined {
    return current
  },
  set(id: string | undefined) {
    current = id
  },
}
