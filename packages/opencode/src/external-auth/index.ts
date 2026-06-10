// testagent_change - new file
// External user authentication with auto-login flow.
// Mirrors the tsCodeAuth logic from the VS Code extension:
//   1. Check stored token → return immediately if valid
//   2. Generate app_code (e.g. "AB3X-9KZQ"), open browser to sign-in page
//   3. Poll relate-token endpoint every 3s until returnCode === 'SUC0000'
//   4. Persist full token payload for future runs

import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"
import open from "open"
import * as prompts from "@clack/prompts"

const log = Log.create({ service: "external-auth" })

const file = path.join(Global.Path.data, "external-user.json")

// Matches StoredToken in tsCodeAuth/common/tsCodeAuth.ts
export type StoredToken = {
  userId: string
  userName: string
  token: string
}

// Matches TokenResponse in tsCodeAuth/common/tsCodeAuth.ts
type TokenResponse = {
  returnCode: string
  body?: any
}

export namespace ExternalAuth {
  // ── persistence ──────────────────────────────────────────────────────────

  export async function getToken(): Promise<StoredToken | undefined> {
    const f = Bun.file(file)
    if (!(await f.exists())) return undefined
    const data = await f.json().catch(() => undefined)
    if (!data || typeof data.token !== "string") return undefined
    return data as StoredToken
  }

  export async function saveToken(token: StoredToken): Promise<void> {
    await Bun.write(file, JSON.stringify(token, null, 2))
    const { chmod } = await import("fs/promises")
    await chmod(file, 0o600).catch(() => {})
  }

  export async function clearToken(): Promise<void> {
    const { unlink } = await import("fs/promises")
    await unlink(file).catch(() => {})
  }

  // ── code generator ───────────────────────────────────────────────────────
  // Matches buildAuthorizationUrl() in TsCodeAuthService

  function generateAppCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    const seg = (len: number) =>
      Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("")
    return `${seg(4)}-${seg(4)}`
  }

  // ── config ────────────────────────────────────────────────────────────────

  export type Config = {
    /** Base URL for sign-in page. app_code appended as ?app_code=XXXX */
    baseUrl?: string
    /** Gateway base URL for polling. appCode appended as ?appCode=XXXX */
    gatewayBaseUrl?: string
    /** ms between polls (default 3000, matches VS Code extension) */
    pollInterval?: number
    /** ms before giving up (default 300000 = 5 min) */
    pollTimeout?: number
  }

  const DEFAULT_BASE_URL = "https://xxxxxxx.cn"
  const DEFAULT_GATEWAY_BASE_URL = "https://xxxxxxx.cn"

  // ── main flow ─────────────────────────────────────────────────────────────

  /**
   * Ensures the user is authenticated.
   * - If a valid stored token exists, returns it immediately (silent).
   * - Otherwise shows a spinner, opens the browser, polls until token arrives,
   *   then persists and returns the token.
   */
  export async function ensureAuthenticated(cfg: Config = {}): Promise<StoredToken> {
    const base = cfg.baseUrl ?? DEFAULT_BASE_URL
    const gateway = cfg.gatewayBaseUrl ?? DEFAULT_GATEWAY_BASE_URL
    const interval = cfg.pollInterval ?? 3000
    const timeout = cfg.pollTimeout ?? 300_000

    // 1. Check existing token — silent, no UI
    const existing = await getToken()
    if (existing) {
      log.info("using existing auth token", { userId: existing.userId, userName: existing.userName })
      return existing
    }

    // 2. No token — show login flow with UI
    const appCode = generateAppCode()
    const loginUrl = `${base}/sign-in?app_code=${appCode}`

    prompts.intro("TSCode 登录")
    prompts.log.info(`正在打开浏览器，请完成授权后返回...`)
    prompts.log.info(`登录地址：${loginUrl}`)

    log.info("opening browser for authentication", { appCode, url: loginUrl })
    await open(loginUrl).catch(() => {
      prompts.log.warn("无法自动打开浏览器，请手动访问上方地址")
      log.warn("failed to open browser automatically", { url: loginUrl })
    })

    const spinner = prompts.spinner()
    spinner.start("等待授权中...")

    // 3. Poll relate-token endpoint
    const deadline = Date.now() + timeout

    const poll = async (): Promise<StoredToken> => {
      if (Date.now() >= deadline) {
        spinner.stop("授权超时", 1)
        throw new Error("Authentication timed out — please try again")
      }

      await new Promise((r) => setTimeout(r, interval))

      const res = await fetch(
        `${gateway}/login/relate-token?appCode=${encodeURIComponent(appCode)}`,
        { method: "GET" },
      ).catch(() => undefined)

      if (res?.ok) {
        const data = (await res.json().catch(() => undefined)) as TokenResponse | undefined
        if (data?.returnCode === "SUC0000" && data.body) {
          const stored: StoredToken = {
            userId: data.body.employeeId,
            userName: data.body.userName,
            token: data.body.token,
          }
          await saveToken(stored)
          spinner.stop(`登录成功，欢迎 ${stored.userName ?? stored.userId ?? ""}`)
          prompts.outro("已完成身份验证，正在启动...")
          log.info("authentication successful", {
            userId: stored.userId,
            userName: stored.userName,
          })
          return stored
        }
      } else {
        log.warn("polling relate-token failed, will retry", { status: res?.status })
      }

      return poll()
    }

    return poll()
  }
}
