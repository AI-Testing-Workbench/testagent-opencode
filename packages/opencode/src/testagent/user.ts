// testagent - new file
// Stores the current user info set by the VS Code extension via HTTP or env vars.

interface UserInfo {
  id?: string
  name?: string
}

let current: UserInfo = {
  id: process.env["TESTAGENT_USER_ID"],
  name: process.env["TESTAGENT_USER_NAME"],
}

export const User = {
  get(): UserInfo {
    return current
  },
  set(info: UserInfo) {
    current = info
  },
}
