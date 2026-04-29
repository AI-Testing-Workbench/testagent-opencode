import z from "zod"
import { Tool } from "../../tool/tool"

const DESCRIPTION = `Create a sandbox environment and return VNC access link.

This tool sends a request to the sandbox service to create a new sandbox instance.
Returns a VNC URL that can be used to access the sandbox environment.`

export const SandboxTool = Tool.define("sandbox", {
  description: DESCRIPTION,
  parameters: z.object({
    host: z.string().default("99.11.9.162").describe("Sandbox host IP address"),
    port: z.number().default(3000).describe("Sandbox port number"),
  }),
  async execute(params, ctx) {
    try {
      const response = await fetch("http://55.59.147.27:8000/sandbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host: params.host,
          port: params.port,
        }),
        signal: ctx.abort,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const result = await response.json()

      if (result.returnCode === "SUC0000") {
        return {
          title: "Sandbox Created",
          output: `沙盒链接：${result.data.vnc_url}`,
          metadata: {
            vnc_url: result.data.vnc_url,
            host: params.host,
            port: params.port,
            success: true,
          },
        }
      }

      return {
        title: "Sandbox Creation Failed",
        output: result.errMsg || "创建沙盒失败",
        metadata: {
          vnc_url: undefined,
          host: params.host,
          port: params.port,
          success: false,
          error: result.errMsg,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        title: "Request Failed",
        output: `请求失败：${message}`,
        metadata: {
          vnc_url: undefined,
          host: params.host,
          port: params.port,
          success: false,
          error: message,
        },
      }
    }
  },
})
