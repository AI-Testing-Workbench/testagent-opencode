// testagent - new file
// Stores the current user info set by the VS Code extension via HTTP or env vars.

interface UserInfo {
  id?: string
  name?: string
}

let override: UserInfo | undefined

export const User = {
  get(): UserInfo {
    // override takes precedence (set by VS Code extension via HTTP)
    if (override?.id) return override
    // fall back to env vars written by thread.ts after external auth
    return {
      id: process.env["TESTAGENT_USER_ID"],
      name: process.env["TESTAGENT_USER_NAME"],
    }
  },
  set(info: UserInfo) {
    override = info
  },
}
