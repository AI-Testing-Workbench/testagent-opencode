/**
 * OpenCode Langfuse Plugin (v3.x API)
 * Traces agent execution to Langfuse for observability
 *
 * Features:
 * - Trace creation for each session using unique UUID
 * - LLM generation tracking with full message context
 * - Tool span recording with proper parent-child relationships
 * - Output capture for final responses
 * - Token and cost tracking (if available via events)
 * - Isolated traces for each conversation turn
 */

import { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
declare const LANGFUSE_ENV: string

// ==================== 配置加载 ====================

/**
 * 从 .env 文件加载环境变量
 * @param path .env 文件路径
 * @returns 环境变量对象
 */
function loadEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const idx = trimmed.indexOf("=")
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
      env[key] = val
    }
  }
  return env
}

// ==================== Langfuse 客户端初始化 ====================

// Singleton to ensure only one initialization across all imports
let langfuse: any = null
let initPromise: Promise<void> | null = null

async function ensureLangfuseClient() {
  // If already initialized, return immediately
  if (langfuse) return

  // If initialization is in progress, wait for it
  if (initPromise) {
    await initPromise
    return
  }

  // Start initialization
  initPromise = (async () => {
    console.log("[langfuse] Loading...")

    const embeddedEnv = LANGFUSE_ENV || ""
    const envConfig = loadEnv(embeddedEnv ?? "")

    // 配置 Langfuse 连接信息
    const config = {
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? envConfig.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? envConfig.LANGFUSE_SECRET_KEY,
      baseUrl:
        process.env.LANGFUSE_BASE_URL ??
        envConfig.LANGFUSE_BASE_URL ??
        "https://testhub-agent-trace-dev.paas.cmbchina.cn",
    }

    console.log("[langfuse] Debug:", {
      embeddedEnv: embeddedEnv ? "present" : "absent",
      envConfigKeys: ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"],
    })
    console.log("[langfuse] Config:", {
      hasPK: !!config.publicKey,
      hasSK: !!config.secretKey,
    })

    try {
      const { default: Langfuse } = await import("langfuse")
      langfuse = new Langfuse({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        flushAt: 1, // 每次调用立即刷新
      })
      console.log("[langfuse] Client initialized")
    } catch (e) {
      console.log("[langfuse] Failed:", e)
    }
  })()

  await initPromise
}

// ==================== 会话管理 ====================

let currentSessionId: string | null = null

/**
 * 生成唯一的会话 ID
 * @returns 会话 ID 字符串
 */
function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
}

/**
 * 获取或创建当前会话 ID
 * @param inputSessionId 可选的输入会话 ID
 * @returns 会话 ID
 */
function getSessionId(inputSessionId?: string): string {
  if (inputSessionId) {
    currentSessionId = inputSessionId
  } else if (!currentSessionId) {
    currentSessionId = generateSessionId()
  }
  return currentSessionId
}

// ==================== 数据结构定义 ====================

/**
 * LLM 生成信息接口
 */
interface GenInfo {
  traceId: string // 所属的 Trace ID
  gen: any // Langfuse 生成对象
  modelName: string // 模型名称
  startTime: Date // 开始时间
  completionStartTime: Date | null // 首个 token 时间
  stepNumber: number // 步骤编号
  output: string // 输出内容（纯文本，含 <think>）
  parts: string[] // 部分输出数组
  toolCalls: Array<{ toolCallId: string; name: string; args: any }> // 工具调用信息
  isSkillChild: boolean // 是否为 Skill 的子节点
  hasUsage: boolean // 是否已经收到 usage 信息
  finalOutput: { text: string; tool_calls?: any[]; usage?: any } | null // 缓存最终结构化输出
}

/**
 * Skill 上下文接口
 */
interface SkillContext {
  span: any // Langfuse Span 对象
  traceId: string // 所属的 Trace ID
  gens: GenInfo[] // 该 Skill 内的生成列表
}

// ==================== 全局状态管理 ====================

// 存储所有 Trace 对象
const traces = new Map<string, any>()

// 存储每个 Trace 的生成列表
const gens = new Map<string, GenInfo[]>()

// 存储工具调用的 Span
const toolSpans = new Map<string, any>()

// LIFO 栈，维护嵌套 skill 调用链
const skillStack: { callID: string; context: SkillContext }[] = []

// 全局 generation 列表，按创建顺序记录所有 generation
const allGenerations: GenInfo[] = []

// 当前活跃的 generation（由 chat.params 设置，由 step-finish 清除）
let activeGen: GenInfo | null = null

// 当前活跃的 Trace ID
let currentTraceId: string | null = null

/**
 * 获取当前活跃的父级节点
 * 返回栈顶 skill span
 * @returns 父级节点或 null
 */
function getActiveParent() {
  if (skillStack.length === 0) return null
  return skillStack[skillStack.length - 1].context.span
}

/**
 * 获取当前活跃的 Skill 上下文
 * 返回栈顶 skill context
 * @returns SkillContext 或 null
 */
function getCurrentSkillContext(): SkillContext | null {
  if (skillStack.length === 0) return null
  return skillStack[skillStack.length - 1].context
}

// 存储用户输入
const userInputs = new Map<string, string>()

// 存储 LLM 输入消息
const llmInputs = new Map<string, any[]>()

// 存储 system prompt
const systemPrompts = new Map<string, string[]>()

// 存储 LLM 工具定义
const llmTools = new Map<string, any[]>()

// 全局工具定义缓存（从 tool.definition hook 收集）
const allToolDefs = new Map<string, { id: string; description: string; parameters: any }>()

// 存储 LLM 输出数据
const llmOutputs = new Map<string, { text: string; tool_calls: any[]; usage: any; reasoning: string }>()

// 存储当前生成的索引
const currentGenIdx = new Map<string, number>()

// 跟踪的会话 ID 集合
const trackedSessionIds = new Set<string>()

// 消息计数器，用于生成唯一的 Trace ID（虽然现在用 UUID，但保留用于其他用途）
const messageCounter = new Map<string, number>()

// ==================== 常量 ====================

const OBSERVATION_TAGS = ["testagent"]

// ==================== 工具函数 ====================

/**
 * 敏感信息脱敏
 * @param input 输入对象
 * @returns 脱敏后的对象
 */
function sanitize(input: any): any {
  if (typeof input !== "object" || !input) return input
  const out: any = {}
  for (const [k, v] of Object.entries(input)) {
    // 对包含敏感关键词的字段进行脱敏
    out[k] = /^(key|secret|password|token)$/i.test(k) ? "[REDACTED]" : sanitize(v)
  }
  return out
}

/**
 * 刷新 Langfuse 数据到服务器
 */
function flush() {
  if (langfuse?.flush) {
    langfuse.flush()
  }
}

/**
 * 生成 UUID v4
 * @returns 随机 UUID
 */
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * 创建新的 Trace
 * @param sessionId 会话 ID
 * @param input 输入内容
 * @param ctx 上下文
 * @param traceId Trace ID
 * @returns Langfuse Trace 对象
 */
function createNewTrace(sessionId: string, input: string, ctx: any, traceId: string) {
  if (!langfuse) return null

  const traceName = input.length > 100 ? input.slice(0, 100) + "..." : input

  const trace = langfuse.trace({
    id: traceId, // 使用随机 UUID
    name: traceName,
    sessionId: sessionId, // 通过 sessionId 关联会话
    input,
    tags: OBSERVATION_TAGS,
    metadata: {
      tags: OBSERVATION_TAGS,
      project: ctx.project?.name,
      directory: ctx.directory,
    },
  })

  traces.set(traceId, trace)
  gens.set(traceId, [])
  currentGenIdx.set(traceId, -1)

  return trace
}

/**
 * 格式化消息数组为可读字符串
 * @param messages 消息数组
 * @returns 格式化后的字符串
 */
function formatMessages(messages: any[]): string {
  return messages
    .map((m, idx) => {
      const role = m.info?.role || "unknown"
      const parts =
        m.parts
          ?.map((p: any) => {
            switch (p.type) {
              case "text":
                return `[Text] ${p.text?.substring(0, 300) || ""}`
              case "tool-call":
                return `[ToolCall] ${p.name}(${JSON.stringify(p.args)?.substring(0, 200) || ""})`
              case "tool-result":
                return `[ToolResult] ${p.output?.substring(0, 300) || ""}`
              case "reasoning":
                return `[Reasoning] ${p.text?.substring(0, 200) || ""}`
              case "step-start":
                return `[StepStart] ${p.reason || ""}`
              case "step-finish":
                return `[StepFinish] reason=${p.reason}, tokens=${JSON.stringify(p.tokens)?.substring(0, 100)}, cost=${p.cost}`
              default:
                return `[${p.type}] ${JSON.stringify(p)?.substring(0, 200)}`
            }
          })
          .join("\n  ") || ""
      return `[${idx}] ${role}:\n  ${parts}`
    })
    .join("\n")
}

/**
 * 将内部消息格式转换为标准 LLM 消息格式
 * @param messages 内部消息数组
 * @returns 标准消息数组
 */
function convertToLLMMessages(messages: any[]): any[] {
  return messages
    .filter((m) => m.info?.role && m.parts?.length > 0)
    .map((m) => {
      const role = m.info.role
      const name = m.info.name || role
      const content = m.parts
        .filter(
          (p: any) => p.type === "text" || p.type === "tool-call" || p.type === "tool-result" || p.type === "reasoning",
        )
        .map((p: any) => {
          if (p.type === "text") return { type: "text", text: p.text }
          if (p.type === "tool-call")
            return {
              type: "tool_call",
              tool_call: {
                id: p.toolCallId || "",
                name: p.name,
                arguments: JSON.stringify(p.args || {}),
              },
            }
          if (p.type === "tool-result")
            return {
              type: "tool_result",
              tool_result: {
                tool_call_id: p.toolCallId || "",
                content: p.output,
              },
            }
          if (p.type === "reasoning") return { type: "text", text: p.text }
          return { type: p.type, text: JSON.stringify(p) }
        })
      return { role, name, content }
    })
}

/**
 * 将 Zod schema 转换为纯 JSON Schema 格式
 * 过滤掉 Zod 内部字段（~standard, type, format, minLength 等）
 */
function toJsonSchema(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(toJsonSchema)

  // Zod v4 schema has def.type to identify the type
  if (obj.def && typeof obj.def === "object") {
    return extractFromZodDef(obj.def)
  }

  // Plain object, extract known JSON Schema keys
  return extractJsonSchemaKeys(obj)
}

function extractFromZodDef(def: Record<string, any>): any {
  const result: Record<string, any> = {}

  if (def.description) result.description = def.description

  switch (def.type) {
    case "object": {
      result.type = "object"
      if (def.shape) {
        result.properties = {}
        for (const [key, val] of Object.entries(def.shape)) {
          result.properties[key] = toJsonSchema(val)
        }
      }
      if (def.required && Array.isArray(def.required)) {
        result.required = def.required
      }
      break
    }
    case "array": {
      result.type = "array"
      if (def.element) result.items = toJsonSchema(def.element)
      if (def.minLength != null) result.minItems = def.minLength
      if (def.maxLength != null) result.maxItems = def.maxLength
      break
    }
    case "string": {
      result.type = "string"
      if (def.minLength != null) result.minLength = def.minLength
      if (def.maxLength != null) result.maxLength = def.maxLength
      if (def.pattern != null) result.pattern = def.pattern
      if (def.format != null) result.format = def.format
      break
    }
    case "number": {
      result.type = "number"
      if (def.minimum != null) result.minimum = def.minimum
      if (def.maximum != null) result.maximum = def.maximum
      break
    }
    case "boolean": {
      result.type = "boolean"
      break
    }
    case "enum": {
      if (def.values) result.enum = def.values
      break
    }
    case "union": {
      result.oneOf = (def.choices || []).map(toJsonSchema)
      break
    }
    case "optional":
    case "nullable": {
      if (def.innerType) return toJsonSchema(def.innerType)
      break
    }
    case "literal": {
      if (def.values) result.const = def.values[0]
      break
    }
    default: {
      // Fallback: try to extract basic type
      if (def.type) result.type = def.type
    }
  }

  return result
}

function extractJsonSchemaKeys(obj: Record<string, any>): any {
  const jsonSchemaKeys = new Set([
    "type",
    "properties",
    "items",
    "required",
    "description",
    "enum",
    "const",
    "default",
    "additionalProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "$ref",
    "$defs",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "title",
    "examples",
  ])

  const result: Record<string, any> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (jsonSchemaKeys.has(key)) {
      result[key] = typeof val === "object" && val !== null ? extractJsonSchemaKeys(val) : val
    }
  }
  return Object.keys(result).length > 0 ? result : obj
}

/**
 * 构建 LLM 输入
 * @param messages 内部消息数组
 * @param system 系统 prompt 数组
 * @param tools 工具定义数组
 * @returns { json: string, dict: object }
 */
function toJsonSchema(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(toJsonSchema)

  const result: Record<string, any> = {}
  const jsonSchemaKeys = [
    "type",
    "properties",
    "items",
    "required",
    "description",
    "enum",
    "const",
    "default",
    "additionalProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "$ref",
    "$defs",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "title",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ]

  // If it looks like a Zod schema (has ~standard or def), extract from def
  if ("def" in obj && obj.def && typeof obj.def === "object") {
    const def = obj.def
    // Check if def itself needs recursive cleaning
    if ("shape" in def && def.shape && typeof def.shape === "object") {
      // Object with properties
      result.type = def.type || "object"
      if (def.description) result.description = def.description
      result.properties = {}
      for (const [key, val] of Object.entries(def.shape)) {
        result.properties[key] = toJsonSchema(val)
      }
      if (def.required) result.required = def.required
    } else if ("innerType" in def) {
      // Nullable or optional wrapper
      result.type = def.type || def.innerType?.type || "object"
      if (def.description) result.description = def.description
    } else if (def.type === "array" && "element" in def) {
      result.type = "array"
      if (def.description) result.description = def.description
      result.items = toJsonSchema(def.element)
    } else if (def.type === "enum") {
      result.enum = def.values
      if (def.description) result.description = def.description
    } else {
      // Other zod types, try to extract basic info
      const cleaned = extractJsonSchema(def)
      Object.assign(result, cleaned)
    }
    return { ...result }
  }

  // Not a zod schema, just extract known json schema keys
  return extractJsonSchema(obj)
}

function extractJsonSchema(obj: Record<string, any>): any {
  const result: Record<string, any> = {}
  const jsonSchemaKeys = new Set([
    "type",
    "properties",
    "items",
    "required",
    "description",
    "enum",
    "const",
    "default",
    "additionalProperties",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "$ref",
    "$defs",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
    "title",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
  ])

  for (const [key, val] of Object.entries(obj)) {
    if (jsonSchemaKeys.has(key)) {
      result[key] = typeof val === "object" && val !== null ? extractJsonSchema(val) : val
    }
  }
  return Object.keys(result).length > 0 ? result : obj
}

/**
 * 构建 LLM 输入
 * @param messages 内部消息数组
 * @param system 系统 prompt 数组
 * @param tools 工具定义数组
 * @returns { json: string, dict: object }
 */
function buildLLMInput(messages: any[], system: string[], tools: any[]): { json: string; dict: object } {
  const systemMessages = system.map((s) => ({
    role: "system",
    content: s,
  }))
  const formattedMessages = [...systemMessages, ...convertToLLMMessages(messages)]
  const formattedTools = tools.map((t) => {
    if (t.type === "function") return t
    return {
      type: "function",
      function: {
        name: t.name || t.id || t,
        description: t.description || "",
        parameters: toJsonSchema(t.parameters || { type: "object", properties: {} }),
      },
    }
  })
  const dict = { messages: formattedMessages, tools: formattedTools }
  return { json: JSON.stringify(dict, null, 2), dict }
}

// ==================== 插件主逻辑 ====================

export const LangfusePlugin: Plugin = async (ctx) => {
  // Ensure client is initialized only once
  await ensureLangfuseClient()

  return {
    /**
     * 处理聊天消息事件
     * 每次用户发送消息时触发，创建新的 Trace
     */
    "chat.message": async (input, output) => {
      // 获取或创建会话 ID
      const sessionId = getSessionId(input.sessionID)
      trackedSessionIds.add(sessionId)

      // 提取用户输入的文本内容
      const textParts = output.parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
      const textContent = textParts.map((p) => p.text).join("\n")
      userInputs.set(sessionId, textContent)

      // 使用随机 UUID 作为 Trace ID，不包含冗余的 sessionId 信息
      // 通过 sessionId 字段关联到会话
      const traceId = generateUUID()
      currentTraceId = traceId

      // 消息计数器继续累加，用于其他用途（如清理）
      const count = (messageCounter.get(sessionId) || 0) + 1
      messageCounter.set(sessionId, count)

      // 创建新的 Trace
      const trace = createNewTrace(sessionId, textContent || input.message?.content || "message", ctx, traceId)

      // 更新 Trace 元数据 - 添加完整的 input 和 output
      if (trace) {
        trace.update({
          metadata: {
            messageID: input.messageID,
            messageIndex: count,
            input: {
              sessionID: input.sessionID,
              agent: input.agent,
              model: input.model,
              messageID: input.messageID,
              variant: input.variant,
            },
            output: {
              message: output.message,
              parts: output.parts,
            },
          },
        })
      }
    },

    /**
     * 处理聊天参数事件
     * 在调用 LLM 之前触发，创建 Generation 节点
     */
    "chat.params": async (input, output) => {
      if (!langfuse) return

      // 检查 metadata 中的 PasttoolCalls，如果包含 skill 调用，说明 skill 已结束
      // 当前 LLM 应与 skill 同层级，不再是 skill 的子节点
      const pastToolCalls = input?.message?.metadata?.PasttoolCalls ?? input?.metadata?.PasttoolCalls ?? []
      if (Array.isArray(pastToolCalls) && pastToolCalls.length > 0) {
        const hasSkillCall = pastToolCalls.some((tc: any) => tc?.name === "skill" || tc?.tool === "skill")
        if (hasSkillCall && skillStack.length > 0) {
          const popped = skillStack.pop()
          if (popped) {
            toolSpans.delete(popped.callID)
          }
        }
      }

      const sessionId = currentSessionId || input.sessionID
      const traceId = currentTraceId || generateUUID()

      // 检查是否在 Skill 上下文中
      const skillContext = getCurrentSkillContext()
      const currentParent = getActiveParent()

      // 构建模型名称
      const providerId = input.provider?.info?.id || input.provider?.id || "unknown"
      const modelId = input.model?.id || "unknown"
      const modelName = `${providerId}/${modelId}`

      // 获取 LLM 输入消息、系统 prompt 和工具定义，构建 input
      const messages = llmInputs.get(sessionId) || []
      // 跳过没有实际消息的 generation 创建（第一次 chat.params 可能在 transform 之前触发）
      if (messages.length === 0) return

      const system = systemPrompts.get(sessionId) || []
      const tools = [...allToolDefs.values()]
      const builtInput = buildLLMInput(messages, system, tools)
      const llmInput = builtInput.json
      const llmInputDict = builtInput.dict

      const startTime = new Date()
      let gen: any
      let targetGenList: GenInfo[]
      let targetTraceId: string

      // 构建 model_parameters，传递给 Langfuse SDK
      const modelParameters: Record<string, any> = {}
      if (output.temperature !== undefined) modelParameters.temperature = output.temperature
      if (output.topP !== undefined) modelParameters.top_p = output.topP
      if (output.topK !== undefined) modelParameters.top_k = output.topK
      if (output.maxOutputTokens !== undefined) modelParameters.max_tokens = output.maxOutputTokens

      // 构建 metadata，模型信息包含 name、model、parameters
      const genMetadata = {
        spanKind: "llm",
        model: {
          name: modelName,
          provider: providerId,
          id: modelId,
          parameters: modelParameters,
        },
        input: llmInputDict,
        output: {},
        tags: OBSERVATION_TAGS,
      }

      // 如果在 Skill 上下文中，创建 Skill 的子 Generation
      if (skillContext) {
        gen = skillContext.span.generation({
          name: "llm",
          model: modelName,
          modelParameters,
          input: llmInput,
          startTime: startTime.toISOString(),
          metadata: genMetadata,
          tags: OBSERVATION_TAGS,
        })
        targetGenList = skillContext.gens
        targetTraceId = skillContext.traceId
      } else {
        // 否则创建普通 Generation
        const trace = traces.get(traceId)
        if (!trace) return
        const genList = gens.get(traceId)
        if (!genList) return

        const idx = genList.length
        currentGenIdx.set(traceId, idx)

        const genParams = {
          name: "llm",
          model: modelName,
          modelParameters,
          input: llmInput,
          startTime: startTime.toISOString(),
          metadata: genMetadata,
          tags: OBSERVATION_TAGS,
        }

        // 根据是否有父级节点，决定创建方式
        gen = currentParent ? currentParent.generation(genParams) : trace.generation(genParams)

        targetGenList = genList
        targetTraceId = traceId
      }

      // 记录生成信息
      const genInfo: GenInfo = {
        traceId: targetTraceId,
        gen,
        modelName,
        startTime,
        completionStartTime: null,
        stepNumber: targetGenList.length + 1,
        output: "",
        parts: [],
        toolCalls: [],
        isSkillChild: !!skillContext,
        hasUsage: false,
        finalOutput: null,
      }

      targetGenList.push(genInfo)

      // 同时添加到全局列表
      allGenerations.push(genInfo)

      // 设置为当前活跃的 generation，后续事件将路由到它
      activeGen = genInfo
    },

    /**
     * 转换系统消息
     * 在系统消息发送给 LLM 之前，记录系统 prompt
     */
    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID || currentSessionId || [...trackedSessionIds].pop()
      if (sessionId && output.system && output.system.length > 0) {
        systemPrompts.set(sessionId, output.system)
      }
    },

    /**
     * 转换聊天消息
     * 在消息发送给 LLM 之前，记录消息内容
     */
    "experimental.chat.messages.transform": async (input, output) => {
      const sessionId = input.sessionID || currentSessionId || [...trackedSessionIds].pop()
      if (sessionId) {
        llmInputs.set(sessionId, output.messages)
      }
    },

    /**
     * 工具定义修改
     * 捕获所有工具的定义信息，用于记录到 LLM 输入中
     */
    "tool.definition": async (input, output) => {
      allToolDefs.set(input.toolID, {
        id: input.toolID,
        description: output.description,
        parameters: output.parameters,
      })
    },

    /**
     * 工具执行前事件
     * 创建工具调用的 Span
     */
    "tool.execute.before": async (input, output) => {
      const sessionId = input.sessionID || currentSessionId || [...trackedSessionIds].pop()
      if (!sessionId) return

      const traceId = currentTraceId || generateUUID()

      const isSkill = input.tool === "skill"

      // 确保 Trace 存在
      let trace = traces.get(traceId)
      if (!trace && langfuse) {
        trace = createNewTrace(sessionId, userInputs.get(sessionId) || "tool execution", ctx, traceId)
      }

      if (trace) {
        // 对于 skill，不使用 currentParent，直接挂在 trace 下
        // 对于非 skill 工具，使用 currentParent（可能是 skill）
        const currentParent = isSkill ? null : getActiveParent()

        // 创建工具调用的 Span
        const skillName = output.args?.name || output.args?.skill || "skill"
        const spanName = isSkill ? `skill:${skillName}` : `tool:${input.tool}`
        const spanParams = {
          name: spanName,
          input: sanitize(output.args),
          tags: OBSERVATION_TAGS,
          metadata: {
            spanKind: "tool",
            tags: OBSERVATION_TAGS,
            input: {
              tool: input.tool,
              sessionID: input.sessionID,
              callID: input.callID,
              args: output.args,
            },
          },
        }
        const spanObj = currentParent ? currentParent.span(spanParams) : trace.span(spanParams)

        toolSpans.set(input.callID, spanObj)

        // 如果是 Skill，记录 skill 上下文并压栈
        if (isSkill) {
          const skillContext = { span: spanObj, traceId, gens: [] }
          skillStack.push({ callID: input.callID, context: skillContext })
        }
      }
    },

    /**
     * 工具执行后事件
     * 结束工具调用的 Span
     */
    "tool.execute.after": async (input, output) => {
      const span = toolSpans.get(input.callID)
      if (span) {
        const isSkill = input.tool === "skill"
        const level = output.output === null ? "ERROR" : "DEFAULT"

        span.end({
          output: output.output === null ? null : String(output.output).slice(0, 10000),
          level,
          metadata: {
            spanKind: "tool",
            tags: OBSERVATION_TAGS,
            output: {
              title: output.title,
              output: output.output,
              metadata: output.metadata,
            },
            input: {
              tool: input.tool,
              sessionID: input.sessionID,
              callID: input.callID,
              args: input.args,
            },
          },
        })

        if (!isSkill) {
          toolSpans.delete(input.callID)
        }
      }

      flush()
    },

    /**
     * 文本补全事件
     * 更新 LLM 生成的输出
     */
    "experimental.text.complete": async (input, output) => {
      const g = activeGen
      if (!g) return

      g.output = output.text

      g.gen.update({
        output: output.text,
        metadata: {
          spanKind: "llm",
          model: g.gen.metadata?.model,
          input: g.gen.metadata?.input,
          output: { text: output.text },
          tags: OBSERVATION_TAGS,
        },
      })
    },

    /**
     * 通用事件处理器
     */
    event: async (input: any) => {
      const evt = input?.event
      if (!evt) return

      // 服务器实例销毁时，刷新数据
      if (evt.type === "server.instance.disposed") {
        flush()
        return
      }

      // 会话创建时，跟踪会话 ID
      if (evt.type === "session.created") {
        const sid = evt.properties?.info?.id
        if (sid) trackedSessionIds.add(sid)
      }

      // 消息部分更新事件
      if (evt.type === "message.part.updated" && evt.properties?.part) {
        const part = evt.properties.part
        const sessionId = part.sessionID || currentSessionId
        if (!sessionId) return

        // 使用 activeGen 进行事件路由，确保每个事件都路由到正确的 generation
        const g = activeGen

        // 先收集各种类型的部分输出，并在首次收到内容时记录 completionStartTime
        // 必须在 step-finish 处理之前执行，否则 activeGen 会被清空
        if (g && part.type !== "step-finish") {
          if (part.type === "text" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              g.gen.update({
                completionStartTime: g.completionStartTime.toISOString(),
              })
            }
            g.parts.push(part.text)
          }
          if (part.type === "reasoning" && part.text) {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              g.gen.update({
                completionStartTime: g.completionStartTime.toISOString(),
              })
            }
            g.parts.push(`Reasoning: ${part.text.substring(0, 500)}`)
          }
          if (part.type === "tool" && part.state?.status === "running") {
            if (!g.completionStartTime) {
              g.completionStartTime = new Date()
              g.gen.update({
                completionStartTime: g.completionStartTime.toISOString(),
              })
            }
            const toolName = part.tool
            const toolArgs = part.state?.input ?? {}
            const toolStr = `Tool Call: ${toolName}(${JSON.stringify(toolArgs)?.substring(0, 500)})`
            if (!g.parts.some((p) => p.startsWith(`Tool Call: ${toolName}(`))) {
              g.parts.push(toolStr)
            }
            if (!g.toolCalls.some((tc) => tc.toolCallId === (part.callID || ""))) {
              g.toolCalls.push({
                toolCallId: part.callID || "",
                name: toolName,
                args: toolArgs,
              })
            }
          }
          if (part.type === "tool-result") {
            g.parts.push(`Tool Result: ${part.output?.substring(0, 1000) || ""}`)
          }
        }

        // 处理步骤完成事件
        if (part.type === "step-finish" && part.tokens && g) {
          // Step 完成后，判断是否要结束 skill 栈
          if (part.reason !== "tool-calls" && skillStack.length > 0) {
            const popped = skillStack.pop()
            if (popped) {
              toolSpans.delete(popped.callID)
            }
          }

          const endTime = new Date()

          // 若首 token 时间未记录（纯工具调用节点），用 endTime 兜底避免 time_to_first_token = 总 latency
          if (!g.completionStartTime) {
            g.completionStartTime = endTime
            g.gen.update({ completionStartTime: endTime.toISOString() })
          }

          // 从 parts 中提取纯文本内容（排除 Tool Call/Result/Reasoning 标记）
          const textContent = g.parts
            .filter((p) => !p.startsWith("Tool Call:") && !p.startsWith("Tool Result:") && !p.startsWith("Reasoning:"))
            .join("\n\n")
          const reasonText = g.parts
            .filter((p) => p.startsWith("Reasoning:"))
            .map((p) => p.replace(/^Reasoning: /, ""))
            .join("\n")
          const fullText = reasonText ? `<think>\n${reasonText}</think>\n\n${textContent}` : textContent

          // 构建 tool_calls 数组
          const toolCallsOutput = g.toolCalls.map((tc) => ({
            type: "tool_use",
            id: tc.toolCallId || `call_${Math.random().toString(36).substring(2, 12)}`,
            name: tc.name,
            input: tc.args || {},
          }))

          // 构建结构化输出: { text, tool_calls, usage }
          const structuredOutput = {
            text: fullText,
            tool_calls: toolCallsOutput.length > 0 ? toolCallsOutput : undefined,
            usage: {
              input_tokens: part.tokens.input ?? 0,
              output_tokens: part.tokens.output ?? 0,
              total_tokens: part.tokens.total ?? 0,
            },
          }

          g.gen.update({
            endTime: endTime.toISOString(),
            usage: {
              input: part.tokens.input ?? 0,
              output: part.tokens.output ?? 0,
              total: part.tokens.total ?? 0,
            },
            output: JSON.stringify(structuredOutput, null, 2),
            metadata: {
              spanKind: "llm",
              model: g.gen.metadata?.model,
              input: g.gen.metadata?.input,
              output: structuredOutput,
              tags: OBSERVATION_TAGS,
            },
          })

          // 缓存最终结构化输出，供 session.idle 读取
          g.finalOutput = structuredOutput

          // 标记这个 generation 已经收到 step-finish，清除 activeGen
          g.hasUsage = true
          activeGen = null
        }
      }

      // 会话空闲事件
      if (evt.type === "session.idle") {
        const idleSessionId = evt.sessionID ?? evt.properties?.sessionID
        const sessionId = idleSessionId || currentSessionId || [...trackedSessionIds].pop()
        if (!sessionId) return

        const count = messageCounter.get(sessionId) || 1
        const traceId = currentTraceId || generateUUID()

        const trace = traces.get(traceId)

        // 辅助函数：从 GenInfo 构建结构化输出并缓存到 g.finalOutput
        const resolveOutput = (g: GenInfo) => {
          if (g.finalOutput) return g.finalOutput

          const textContent = g.parts
            .filter((p) => !p.startsWith("Tool Call:") && !p.startsWith("Tool Result:") && !p.startsWith("Reasoning:"))
            .join("\n\n")
          const reasonText = g.parts
            .filter((p) => p.startsWith("Reasoning:"))
            .map((p) => p.replace(/^Reasoning: /, ""))
            .join("\n")
          const fullText = reasonText ? `<think>\n${reasonText}</think>\n\n${textContent}` : textContent

          const toolCallsOutput = g.toolCalls.map((tc) => ({
            type: "tool_use",
            id: tc.toolCallId || `call_${Math.random().toString(36).substring(2, 12)}`,
            name: tc.name,
            input: tc.args || {},
          }))

          const out = {
            text: fullText || g.output,
            tool_calls: toolCallsOutput.length > 0 ? toolCallsOutput : undefined,
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          }

          g.gen.update({
            output: JSON.stringify(out, null, 2),
            metadata: {
              spanKind: "llm",
              model: g.gen.metadata?.model,
              output: out,
              tags: OBSERVATION_TAGS,
            },
          })
          g.finalOutput = out
          return out
        }

        // 确保所有 generation 都有最终输出
        for (const g of allGenerations) resolveOutput(g)

        // 更新 Trace 的最终输出：取最后一个 LLM generation 的 text，去掉 <think>...</think> 内容
        if (trace && allGenerations.length > 0) {
          const last = allGenerations[allGenerations.length - 1]!
          const rawText = last.finalOutput?.text || last.output || ""
          const finalText = rawText.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
          trace.update({ output: finalText })
        }

        flush()

        // 清理所有相关数据
        for (let i = 1; i <= count; i++) {
          const oldTraceId = `${sessionId}-msg-${i}`
          traces.delete(oldTraceId)
          gens.delete(oldTraceId)
          currentGenIdx.delete(oldTraceId)
        }

        // 清理 skill 栈、activeGen 和全局 generation 列表
        skillStack.length = 0
        activeGen = null
        toolSpans.clear()
        allGenerations.length = 0
        allToolDefs.clear()

        messageCounter.delete(sessionId)
        userInputs.delete(sessionId)
        llmInputs.delete(sessionId)
        systemPrompts.delete(sessionId)
        llmTools.delete(sessionId)
        llmOutputs.delete(sessionId)
        currentTraceId = null
      }

      // 会话错误事件
      if (evt.type === "session.error") {
        const sessionId = evt.sessionID || currentSessionId
        if (sessionId) {
          const traceId = currentTraceId || generateUUID()
          const trace = traces.get(traceId)
          if (trace) {
            trace.update({ metadata: { error: evt.error?.message } })
          }
        }
        flush()
      }
    },
  }
}

export default LangfusePlugin
