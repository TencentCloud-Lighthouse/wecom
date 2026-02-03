/**
 * WeCom 配置 Schema (Zod)
 */

import { z } from "zod";

/**
 * **dmSchema (单聊配置)**
 * 
 * 控制单聊行为（如允许名单、策略）。
 * @property enabled - 是否启用单聊 [默认: true]
 * @property policy - 访问策略: "pairing" (需配对, 默认), "allowlist" (仅在名单), "open" (所有人), "disabled" (禁用)
 * @property allowFrom - 允许的用户ID或群ID列表 (仅当 policy="allowlist" 时生效)
 */
const dmSchema = z.object({
    enabled: z.boolean().optional(),
    policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
}).optional();

/**
 * **mediaSchema (媒体处理配置)**
 * 
 * 控制媒体文件的下载和缓存行为。
 * @property tempDir - 临时文件下载目录
 * @property retentionHours - 临时文件保留时间（小时）
 * @property cleanupOnStart - 启动时是否自动清理旧文件
 * @property maxBytes - 允许下载的最大字节数
 */
const mediaSchema = z.object({
    tempDir: z.string().optional(),
    retentionHours: z.number().optional(),
    cleanupOnStart: z.boolean().optional(),
    maxBytes: z.number().optional(),
}).optional();

/**
 * **networkSchema (网络配置)**
 * 
 * 控制 HTTP 请求行为，特别是出站代理。
 * @property timeoutMs - 请求超时时间 (毫秒)
 * @property retries - 重试次数
 * @property retryDelayMs - 重试间隔 (毫秒)
 * @property egressProxyUrl - 出站 HTTP 代理 (如 "http://127.0.0.1:7890")
 */
const networkSchema = z.object({
    timeoutMs: z.number().optional(),
    retries: z.number().optional(),
    retryDelayMs: z.number().optional(),
    egressProxyUrl: z.string().optional(),
}).optional();

/**
 * **botSchema (Bot 模式配置)**
 * 
 * 用于配置企业微信内部机器人 (Webhook 模式)。
 * @property token - 企业微信后台设置的 Token
 * @property encodingAESKey - 企业微信后台设置的 EncodingAESKey
 * @property receiveId - (可选) 接收者ID，通常不用填
 * @property streamPlaceholderContent - (可选) 流式响应中的占位符，默认为 "Thinking..."或空
 * @property welcomeText - (可选) 用户首次对话时的欢迎语
 * @property dm - 单聊策略覆盖配置
 */
const botSchema = z.object({
    token: z.string(),
    encodingAESKey: z.string(),
    receiveId: z.string().optional(),
    streamPlaceholderContent: z.string().optional(),
    welcomeText: z.string().optional(),
    dm: dmSchema,
}).optional();

/**
 * **agentSchema (Agent 模式配置)**
 * 
 * 用于配置企业微信自建应用 (Agent)。
 * @property corpId - 企业 ID (CorpID)
 * @property corpSecret - 应用 Secret
 * @property agentId - 应用 AgentId (数字)
 * @property token - 回调配置 Token
 * @property encodingAESKey - 回调配置 EncodingAESKey
 * @property welcomeText - (可选) 欢迎语
 * @property dm - 单聊策略覆盖配置
 */
const agentSchema = z.object({
    corpId: z.string(),
    corpSecret: z.string(),
    agentId: z.union([z.string(), z.number()]),
    token: z.string(),
    encodingAESKey: z.string(),
    welcomeText: z.string().optional(),
    dm: dmSchema,
}).optional();

/** 顶层 WeCom 配置 Schema */
export const WecomConfigSchema = z.object({
    enabled: z.boolean().optional(),
    bot: botSchema,
    agent: agentSchema,
    media: mediaSchema,
    network: networkSchema,
});

export type WecomConfigInput = z.infer<typeof WecomConfigSchema>;
