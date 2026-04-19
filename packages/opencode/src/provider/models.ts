import { Global } from "../global"
import path from "path"
import z from "zod"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "../util/filesystem"
import { Flock } from "@/util/flock"
import { Hash } from "@/util/hash"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist
/* @ts-ignore */

export namespace ModelsDev {
  const filepath = path.join(Global.Path.cache, "models.json")

  export const Model = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string(),
    attachment: z.boolean(),
    reasoning: z.boolean(),
    temperature: z.boolean(),
    tool_call: z.boolean(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cache_read: z.number().optional(),
        cache_write: z.number().optional(),
        context_over_200k: z
          .object({
            input: z.number(),
            output: z.number(),
            cache_read: z.number().optional(),
            cache_write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z.boolean().optional(),
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
    options: z.record(z.string(), z.any()),
    headers: z.record(z.string(), z.string()).optional(),
    provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
    variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
  })
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  export const Data = lazy(async () => {
    const result = await Filesystem.readJson(Flag.OPENCODE_MODELS_PATH ?? filepath).catch(() => {})
    if (result) return result
    // testagent_change - no bundled snapshot, users must configure models manually
    return {}
  })

  export async function get() {
    const result = await Data()
    const providers = result as Record<string, Provider>

    // testagent_change start - inject DeepSeek with dynamic model fetching
    if (!providers["deepseek"]) {
      console.log("[testagent] injecting deepseek provider")
      const models = await fetchDeepSeekModels().catch((e) => {
        console.error("[testagent] deepseek model fetch failed:", e)
        return {} as Record<string, ModelsDev.Model>
      })
      console.log("[testagent] deepseek models count:", Object.keys(models).length)
      providers["deepseek"] = {
        id: "deepseek",
        name: "DeepSeek",
        env: ["DEEPSEEK_API_KEY"],
        api: "https://api.deepseek.com/v1",
        npm: "@ai-sdk/openai-compatible",
        models,
      }
    }
    // testagent_change end

    return providers
  }

  export async function refresh() {
    // Remote fetch disabled — models come from build-time snapshot only // testagent_change
  }
}

// testagent_change start - fetch DeepSeek models from /models endpoint
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
const DEEPSEEK_API_KEY = "sk-c541f40ae55e494b9edcbb218a25fbbe"

async function fetchDeepSeekModels(): Promise<Record<string, ModelsDev.Model>> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? DEEPSEEK_API_KEY
  const baseURL = (process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "")
  const url = `${baseURL}/models`

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`DeepSeek /models returned HTTP ${response.status}`)
  }

  const json = (await response.json()) as { data?: Array<{ id: string; owned_by?: string }> }
  const result: Record<string, ModelsDev.Model> = {}

  for (const item of json.data ?? []) {
    if (!item.id) continue
    result[item.id] = {
      id: item.id,
      name: item.id,
      family: item.owned_by ?? "deepseek",
      release_date: "",
      attachment: false,
      reasoning: item.id.includes("reasoner"),
      temperature: true,
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: { context: 65536, output: 8192 },
      options: {},
      modalities: {
        input: ["text"],
        output: ["text"],
      },
    }
  }

  return result
}
// testagent_change end
