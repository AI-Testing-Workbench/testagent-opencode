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
console.log("[langfuse] Loading...")

import { Plugin } from "@opencode-ai/plugin"

declare const LANGFUSE_ENV: string

// ==================== 配置加载 ====================

const embeddedEnv = LANGFUSE_ENV || ""

/**
 * 从 .env 内容加载环境变量
 * @param content .env 文件内容
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

const envConfig = loadEnv(embeddedEnv ?? "")

// 配置 Langfuse 连接信息
const config = {
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? envConfig.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? envConfig.LANGFUSE_SECRET_KEY,
  baseUrl:
    process.env.LANGFUSE_BASE_URL ?? envConfig.LANGFUSE_BASE_URL ?? "https://testhub-agent-trace-dev.paas.cmbchina.cn",
}

console.log("[langfuse] Config:", {
  hasPK: !!config.publicKey,
  hasSK: !!config.secretKey,
})

// ==================== Langfuse 客户端初始化 ====================

let langfuse: any = null

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
  output: string // 输出内容
  parts: string[] // 部分输出数组
  isSkillChild: boolean // 是否为 Skill 的子节点
  hasUsage: boolean // 是否已经收到 usage 信息
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

// 存储当前生成的索引
const currentGenIdx = new Map<string, number>()

// 跟踪的会话 ID 集合
const trackedSessionIds = new Set<string>()

// 消息计数器，用于生成唯一的 Trace ID（虽然现在用 UUID，但保留用于其他用途）
const messageCounter = new Map<string, number>()

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

  const trace = langfuse.trace({
    id: traceId, // 使用随机 UUID
    name: "opencode-agent",
    sessionId: sessionId, // 通过 sessionId 关联会话
    input,
    metadata: {
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

// ==================== 插件主逻辑 ====================

export const LangfusePlugin: Plugin = async (ctx) => {
  console.log("[langfuse] Plugin started")

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

      // 更新 Trace 元数据
      if (trace) {
        trace.update({
          metadata: {
            messageID: input.messageID,
            messageIndex: count,
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

      const sessionId = currentSessionId || input.sessionID
      const traceId = currentTraceId || generateUUID()

      // 检查是否在 Skill 上下文中
      const skillContext = getCurrentSkillContext()
      const currentParent = getActiveParent()

      // 构建模型名称
      const providerId = input.provider?.info?.id || input.provider?.id || "unknown"
      const modelId = input.model?.id || "unknown"
      const modelName = `${providerId}/${modelId}`

      // 获取 LLM 输入消息
      const messages = llmInputs.get(sessionId) || []
      const llmInput = formatMessages(messages) || input.message?.content || userInputs.get(sessionId) || "message"

      const startTime = new Date()
      let gen: any
      let targetGenList: GenInfo[]
      let targetTraceId: string

      // 如果在 Skill 上下文中，创建 Skill 的子 Generation
      if (skillContext) {
        gen = skillContext.span.generation({
          name: `llm-skill-${skillContext.gens.length + 1}`,
          model: modelName,
          input: llmInput,
          startTime: startTime.toISOString(),
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

        // 根据是否有父级节点，决定创建方式
        gen = currentParent
          ? currentParent.generation({
              name: `llm-${idx + 1}`,
              model: modelName,
              input: llmInput,
              startTime: startTime.toISOString(),
            })
          : trace.generation({
              name: `llm-${idx + 1}`,
              model: modelName,
              input: llmInput,
              startTime: startTime.toISOString(),
            })

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
        isSkillChild: !!skillContext,
        hasUsage: false,
      }

      targetGenList.push(genInfo)

      // 同时添加到全局列表
      allGenerations.push(genInfo)
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
        const spanObj = currentParent
          ? currentParent.span({
              name: `tool:${input.tool}`,
              input: sanitize(output.args),
            })
          : trace.span({
              name: `tool:${input.tool}`,
              input: sanitize(output.args),
            })

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

        span.end({ output: String(output.output).slice(0, 10000) })

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
      const sessionId = input.sessionID || currentSessionId
      const traceId = currentTraceId || generateUUID()

      const idx = currentGenIdx.get(traceId) ?? -1
      const genList = gens.get(traceId)

      if (genList && idx >= 0 && idx < genList.length) {
        const g = genList[idx]
        g.output = output.text

        // 如果是首次收到输出，记录 completionStartTime
        if (!g.completionStartTime) {
          g.completionStartTime = new Date()
          g.gen.update({
            output: output.text,
            completionStartTime: g.completionStartTime.toISOString(),
          })
        } else {
          g.gen.update({ output: output.text })
        }
      }
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

        // 处理步骤完成事件
        if (part.type === "step-finish" && part.tokens) {
          // Step 完成后，判断是否要结束 skill 栈
          // 如果 finishReason 不是 "tool-calls"，说明 LLM 没有产生新的工具调用
          // 这表示当前 skill 的任务已完成
          if (part.reason !== "tool-calls" && skillStack.length > 0) {
            const popped = skillStack.pop()
            if (popped) {
              toolSpans.delete(popped.callID)
            }
          }

          // 从全局列表中找到最近创建的、还没有收到 step-finish 的 generation
          // 倒序遍历，找到第一个没有 usage 信息的 generation
          for (let i = allGenerations.length - 1; i >= 0; i--) {
            const g = allGenerations[i]
            // 检查这个 generation 是否已经有 usage 信息
            // 如果没有，说明这是它的 step-finish 事件
            if (!g.hasUsage) {
              const endTime = new Date()
              const latencyMs = endTime.getTime() - g.startTime.getTime()
              const latencySec = latencyMs / 1000
              const timeToFirstTokenSec = g.completionStartTime
                ? (g.completionStartTime.getTime() - g.startTime.getTime()) / 1000
                : null

              const finalOutput = g.parts.length > 0 ? g.parts.join("\n\n") : g.output

              // 更新生成信息，包括性能指标
              g.gen.update({
                endTime: endTime.toISOString(),
                output:
                  finalOutput || `Step ${g.stepNumber} completed with ${part.tokens.total} tokens, cost ${part.cost}`,
                usage: {
                  promptTokens: part.tokens.input,
                  completionTokens: part.tokens.output,
                  totalTokens: part.tokens.total,
                },
                metadata: {
                  cost: part.cost,
                  reasoningTokens: part.tokens.reasoning,
                  cacheRead: part.tokens.cache?.read,
                  cacheWrite: part.tokens.cache?.write,
                  latencyMs: latencyMs,
                  latencySec: latencySec,
                  timeToFirstTokenSec: timeToFirstTokenSec,
                },
              })

              // 标记这个 generation 已经收到 step-finish
              g.hasUsage = true
              break
            }
          }
        }

        // 收集各种类型的部分输出
        // 找到当前正在生成的 generation（最后一个）
        if (allGenerations.length > 0) {
          const currentGen = allGenerations[allGenerations.length - 1]

          if (part.type === "text" && part.text) {
            currentGen.parts.push(part.text)
          }
          if (part.type === "tool-call") {
            currentGen.parts.push(`Tool Call: ${part.name}(${JSON.stringify(part.args)?.substring(0, 500)})`)
          }
          if (part.type === "tool-result") {
            currentGen.parts.push(`Tool Result: ${part.output?.substring(0, 1000) || ""}`)
          }
          if (part.type === "reasoning" && part.text) {
            currentGen.parts.push(`Reasoning: ${part.text.substring(0, 500)}`)
          }
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
        const genList = gens.get(traceId)

        // 收集所有 generation 的输出（包括 trace 级别和 skill 级别）
        const allOutputs: string[] = []

        // 更新 trace 级别的所有 generation
        if (genList) {
          for (const g of genList) {
            const finalOutput = g.parts.length > 0 ? g.parts.join("\n\n") : g.output
            if (finalOutput) {
              g.gen.update({ output: finalOutput })
              allOutputs.push(finalOutput)
            }
          }
        }

        // 更新所有 skill 内的 generation
        for (const entry of skillStack) {
          for (const g of entry.context.gens) {
            const finalOutput = g.parts.length > 0 ? g.parts.join("\n\n") : g.output
            if (finalOutput && g.gen) {
              g.gen.update({ output: finalOutput })
              allOutputs.push(finalOutput)
            }
          }
        }

        // 更新 Trace 的最终输出：使用最后一个有内容的输出
        if (trace && allOutputs.length > 0) {
          const finalTraceOutput = allOutputs[allOutputs.length - 1]
          trace.update({ output: finalTraceOutput })
        }

        flush()

        // 清理所有相关数据
        for (let i = 1; i <= count; i++) {
          const oldTraceId = `${sessionId}-msg-${i}`
          traces.delete(oldTraceId)
          gens.delete(oldTraceId)
          currentGenIdx.delete(oldTraceId)
        }

        // 清理 skill 栈和全局 generation 列表
        skillStack.length = 0
        toolSpans.clear()
        allGenerations.length = 0

        messageCounter.delete(sessionId)
        userInputs.delete(sessionId)
        llmInputs.delete(sessionId)
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
