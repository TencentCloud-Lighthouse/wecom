import type { IncomingMessage, ServerResponse } from "node:http";

import crypto from "node:crypto";

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import type { ResolvedAgentAccount } from "./types/index.js";
import type { ResolvedBotAccount } from "./types/index.js";
import type { WecomInboundMessage, WecomInboundQuote } from "./types.js";
import { decryptWecomEncrypted, encryptWecomPlaintext, verifyWecomSignature, computeWecomMsgSignature } from "./crypto.js";
import { getWecomRuntime } from "./runtime.js";
import { decryptWecomMedia, decryptWecomMediaWithHttp } from "./media.js";
import { WEBHOOK_PATHS } from "./types/constants.js";
import { handleAgentWebhook } from "./agent/index.js";
import { resolveWecomEgressProxyUrl } from "./config/index.js";
import { wecomFetch } from "./http.js";
import axios from "axios";

/**
 * **核心监控模块 (Monitor Loop)**
 * 
 * 负责接收企业微信 Webhook 回调，处理消息流、媒体解密、消息去重防抖，并分发给 Agent 处理。
 * 它是插件与企业微信交互的“心脏”，管理着所有会话的生命周期。
 */

import type { WecomRuntimeEnv, WecomWebhookTarget, StreamState, PendingInbound, ActiveReplyState } from "./monitor/types.js";
import { monitorState, LIMITS } from "./monitor/state.js";

// Global State
monitorState.streamStore.setFlushHandler((pending) => void flushPending(pending));

// Stores (convenience aliases)
const streamStore = monitorState.streamStore;
const activeReplyStore = monitorState.activeReplyStore;

// Target Registry
const webhookTargets = new Map<string, WecomWebhookTarget[]>();

// Agent 模式 target 存储
type AgentWebhookTarget = {
  agent: ResolvedAgentAccount;
  config: OpenClawConfig;
  runtime: WecomRuntimeEnv;
  // ...
};
const agentTargets = new Map<string, AgentWebhookTarget>();

const pendingInbounds = new Map<string, PendingInbound>();

const STREAM_MAX_BYTES = LIMITS.STREAM_MAX_BYTES;
// REQUEST_TIMEOUT_MS is available in LIMITS but defined locally in other functions, we can leave it or use LIMITS.REQUEST_TIMEOUT_MS
// Keeping local variables for now if they are used, or we can replace usages.
// The constants STREAM_TTL_MS and ACTIVE_REPLY_TTL_MS are internalized in state.ts, so we can remove them here.

/** 错误提示信息 */
const ERROR_HELP = "\n\n遇到问题？联系作者: YanHaidao (微信: YanHaidao)";

/**
 * **normalizeWebhookPath (标准化 Webhook 路径)**
 * 
 * 将用户配置的路径统一格式化为以 `/` 开头且不以 `/` 结尾的字符串。
 * 例如: `wecom` -> `/wecom`
 */
function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}


/**
 * **ensurePruneTimer (启动清理定时器)**
 * 
 * 当有活跃的 Webhook Target 注册时，调用 MonitorState 启动自动清理任务。
 * 清理任务包括：删除过期 Stream、移除无效 Active Reply URL 等。
 */
function ensurePruneTimer() {
  monitorState.startPruning();
}

/**
 * **checkPruneTimer (检查并停止清理定时器)**
 * 
 * 当没有活跃的 Webhook Target 时（Bot 和 Agent 均移除），停止清理任务以节省资源。
 */
function checkPruneTimer() {
  const hasBot = webhookTargets.size > 0;
  const hasAgent = agentTargets.size > 0;
  if (!hasBot && !hasAgent) {
    monitorState.stopPruning();
  }
}




function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  const slice = buf.subarray(buf.length - maxBytes);
  return slice.toString("utf8");
}

/**
 * **jsonOk (返回 JSON 响应)**
 * 
 * 辅助函数：向企业微信服务器返回 HTTP 200 及 JSON 内容。
 * 注意企业微信要求加密内容以 Content-Type: text/plain 返回，但这里为了通用性使用了标准 JSON 响应，
 * 并通过 Content-Type 修正适配。
 */
function jsonOk(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  // WeCom's reference implementation returns the encrypted JSON as text/plain.
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * **readJsonBody (读取 JSON 请求体)**
 * 
 * 异步读取 HTTP 请求体并解析为 JSON。包含大小限制检查，防止大包攻击。
 * 
 * @param req HTTP 请求对象
 * @param maxBytes 最大允许字节数
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/**
 * **buildEncryptedJsonReply (构建加密回复)**
 * 
 * 将明文 JSON 包装成企业微信要求的加密 XML/JSON 格式（此处实际返回 JSON 结构）。
 * 包含签名计算逻辑。
 */
function buildEncryptedJsonReply(params: {
  account: ResolvedBotAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msgsignature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}

function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.searchParams;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

function resolveSignatureParam(params: URLSearchParams): string {
  return (
    params.get("msg_signature") ??
    params.get("msgsignature") ??
    params.get("signature") ??
    ""
  );
}

function buildStreamPlaceholderReply(params: {
  streamId: string;
  placeholderContent?: string;
}): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = params.placeholderContent?.trim() || "1";
  return {
    msgtype: "stream",
    stream: {
      id: params.streamId,
      finish: false,
      // Spec: "第一次回复内容为 1" works as a minimal placeholder.
      content,
    },
  };
}

function buildStreamReplyFromState(state: StreamState): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  // Images handled? The original code had image logic.
  // Ensure we return message item if images exist
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
      ...(state.finished && state.images?.length ? {
        msg_item: state.images.map(img => ({
          msgtype: "image",
          image: { base64: img.base64, md5: img.md5 }
        }))
      } : {})
    },
  };
}

function storeActiveReply(streamId: string, responseUrl?: string, proxyUrl?: string): void {
  activeReplyStore.store(streamId, responseUrl, proxyUrl);
}

function getActiveReplyUrl(streamId: string): string | undefined {
  return activeReplyStore.getUrl(streamId);
}

async function useActiveReplyOnce(streamId: string, fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>): Promise<void> {
  return activeReplyStore.use(streamId, fn);
}


function normalizeWecomAllowFromEntry(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^wecom:/, "")
    .replace(/^user:/, "")
    .replace(/^userid:/, "");
}

function isWecomSenderAllowed(senderUserId: string, allowFrom: string[]): boolean {
  const list = allowFrom.map((entry) => normalizeWecomAllowFromEntry(entry)).filter(Boolean);
  if (list.includes("*")) return true;
  const normalizedSender = normalizeWecomAllowFromEntry(senderUserId);
  if (!normalizedSender) return false;
  return list.includes(normalizedSender);
}

function logVerbose(target: WecomWebhookTarget, message: string): void {
  const should =
    target.core.logging?.shouldLogVerbose?.() ??
    (() => {
      try {
        return getWecomRuntime().logging.shouldLogVerbose();
      } catch {
        return false;
      }
    })();
  if (!should) return;
  target.runtime.log?.(`[wecom] ${message}`);
}

function parseWecomPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

type InboundResult = {
  body: string;
  media?: {
    buffer: Buffer;
    contentType: string;
    filename: string;
  };
};

/**
 * **processInboundMessage (处理接收消息)**
 * 
 * 解析企业微信传入的消息体。
 * 主要职责：
 * 1. 识别媒体消息（Image/File/Mixed）。
 * 2. 如果存在媒体文件，调用 `media.ts` 进行解密和下载。
 * 3. 构造统一的 `InboundResult` 供后续 Agent 处理。
 * 
 * @param target Webhook 目标配置
 * @param msg 企业微信原始消息对象
 */
async function processInboundMessage(target: WecomWebhookTarget, msg: WecomInboundMessage): Promise<InboundResult> {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const aesKey = target.account.encodingAESKey;
  const mediaMaxMb = 5; // Default 5MB
  const maxBytes = mediaMaxMb * 1024 * 1024;
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  if (msgtype === "image") {
    const url = String((msg as any).image?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
        return {
          body: "[image]",
          media: {
            buffer: buf,
            contentType: "image/jpeg", // WeCom images are usually generic; safest assumption or could act as generic
            filename: "image.jpg",
          }
        };
      } catch (err) {
        target.runtime.error?.(`Failed to decrypt inbound image: ${String(err)}`);
        return { body: `[image] (decryption failed: ${typeof err === 'object' && err ? (err as any).message : String(err)})` };
      }
    }
  }

  if (msgtype === "file") {
    const url = String((msg as any).file?.url ?? "").trim();
    if (url && aesKey) {
      try {
        const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
        return {
          body: "[file]",
          media: {
            buffer: buf,
            contentType: "application/octet-stream",
            filename: "file.bin", // WeCom doesn't guarantee filename in webhook payload always, defaulting
          }
        };
      } catch (err) {
        target.runtime.error?.(`Failed to decrypt inbound file: ${String(err)}`);
        return { body: `[file] (decryption failed: ${typeof err === 'object' && err ? (err as any).message : String(err)})` };
      }
    }
  }

  // Mixed message handling: extract first media if available
  if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      let foundMedia: InboundResult["media"] | undefined = undefined;
      let bodyParts: string[] = [];

      for (const item of items) {
        const t = String(item.msgtype ?? "").toLowerCase();
        if (t === "text") {
          const content = String(item.text?.content ?? "").trim();
          if (content) bodyParts.push(content);
        } else if ((t === "image" || t === "file") && !foundMedia && aesKey) {
          // Found first media, try to download
          const url = String(item[t]?.url ?? "").trim();
          if (url) {
            try {
              const buf = await decryptWecomMediaWithHttp(url, aesKey, { maxBytes, http: { proxyUrl } });
              foundMedia = {
                buffer: buf,
                contentType: t === "image" ? "image/jpeg" : "application/octet-stream",
                filename: t === "image" ? "image.jpg" : "file.bin"
              };
              bodyParts.push(`[${t}]`);
            } catch (err) {
              target.runtime.error?.(`Failed to decrypt mixed ${t}: ${String(err)}`);
              bodyParts.push(`[${t}] (decryption failed)`);
            }
          } else {
            bodyParts.push(`[${t}]`);
          }
        } else {
          // Other items or already found media -> just placeholder
          bodyParts.push(`[${t}]`);
        }
      }
      return {
        body: bodyParts.join("\n"),
        media: foundMedia
      };
    }
  }

  return { body: buildInboundBody(msg) };
}


/**
 * Flush pending inbound messages after debounce timeout.
 * Merges all buffered message contents and starts agent processing.
 */
/**
 * **flushPending (刷新待处理消息 / 核心 Agent 触发点)**
 * 
 * 当防抖计时器结束时被调用。
 * 核心逻辑：
 * 1. 聚合所有 pending 的消息内容（用于上下文）。
 * 2. 获取 PluginRuntime。
 * 3. 标记 Stream 为 Started。
 * 4. 调用 `startAgentForStream` 启动 Agent 流程。
 * 5. 处理异常并更新 Stream 状态为 Error。
 */
async function flushPending(pending: PendingInbound): Promise<void> {
  const { streamId, target, msg, contents, msgids } = pending;

  // Merge all message contents (each is already formatted by buildInboundBody)
  const mergedContents = contents.filter(c => c.trim()).join("\n").trim();

  let core: PluginRuntime | null = null;
  try {
    core = getWecomRuntime();
  } catch (err) {
    logVerbose(target, `flush pending: runtime not ready: ${String(err)}`);
    streamStore.markFinished(streamId);
    return;
  }

  if (core) {
    streamStore.markStarted(streamId);
    const enrichedTarget: WecomWebhookTarget = { ...target, core };
    logVerbose(target, `flush pending: starting agent for ${contents.length} merged messages`);

    // Pass the first msg (with its media structure), and mergedContents for multi-message context
    startAgentForStream({
      target: enrichedTarget,
      accountId: target.account.accountId,
      msg,
      streamId,
      mergedContents: contents.length > 1 ? mergedContents : undefined,
      mergedMsgids: msgids.length > 1 ? msgids : undefined,
    }).catch((err) => {
      streamStore.updateStream(streamId, (state) => {
        state.error = err instanceof Error ? err.message : String(err);
        state.content = state.content || `Error: ${state.error}`;
        state.finished = true;
      });
      target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${String(err)}`);
    });
  }
}


/**
 * **waitForStreamContent (等待流内容)**
 * 
 * 用于长轮询 (Long Polling) 场景：阻塞等待流输出内容，直到超时或流结束。
 * 这保证了用户能尽快收到第一批响应，而不是空转。
 */
async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streamStore.getStream(streamId);
      if (!state) return resolve();
      if (state.error || state.finished) return resolve();
      if (state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * **startAgentForStream (启动 Agent 处理流程)**
 * 
 * 将接收到的（或聚合的）消息转换为 OpenClaw 内部格式，并分发给对应的 Agent。
 * 包含：
 * 1. 消息解密与媒体保存。
 * 2. 路由解析 (Agent Route)。
 * 3. 鉴权 (Command Authorization)。
 * 4. 会话记录 (Session Recording)。
 * 5. 触发 Agent 响应 (Dispatch Reply)。
 * 6. 处理 Agent 输出（包括文本、Markdown 表格转换、<think> 标签保护、模板卡片识别）。
 */
async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  accountId: string;
  msg: WecomInboundMessage;
  streamId: string;
  mergedContents?: string; // Combined content from debounced messages
  mergedMsgids?: string[];
}): Promise<void> {
  const { target, msg, streamId } = params;
  const core = target.core;
  const config = target.config;
  const account = target.account;

  const userid = msg.from?.userid?.trim() || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  // 1. Process inbound message (decrypt media if any)
  let { body: rawBody, media } = await processInboundMessage(target, msg);

  // Override body with merged contents if available (debounced messages)
  if (params.mergedContents) {
    rawBody = params.mergedContents;
  }

  // 2. Save media if present
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (media) {
    try {
      const maxBytes = 5 * 1024 * 1024;
      const saved = await core.channel.media.saveMediaBuffer(
        media.buffer,
        media.contentType,
        "inbound",
        maxBytes,
        media.filename
      );
      mediaPath = saved.path;
      mediaType = saved.contentType;
      logVerbose(target, `saved inbound media to ${mediaPath} (${mediaType})`);
    } catch (err) {
      target.runtime.error?.(`Failed to save inbound media: ${String(err)}`);
    }
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
  });

  logVerbose(target, `starting agent processing (streamId=${streamId}, agentId=${route.agentId}, peerKind=${chatType}, peerId=${chatId})`);

  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${userid}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    dmPolicy !== "open" || shouldComputeAuth
      ? await core.channel.pairing.readAllowFromStore("wecom").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowed = isWecomSenderAllowed(userid, effectiveAllowFrom);
  const allowAllConfigured = effectiveAllowFrom.some((entry) => normalizeWecomAllowFromEntry(entry) === "*");
  const authorizerConfigured = allowAllConfigured || effectiveAllowFrom.length > 0;
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
      useAccessGroups,
      authorizers: [{ configured: authorizerConfigured, allowed: senderAllowed }],
      // When access groups are enabled, authorizers must be configured; if the
      // allowlist is empty, keep commands gated off by default.
    })
    : undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${userid}`,
    To: `wecom:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: userid,
    SenderId: userid,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: msg.msgid,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${chatId}`,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath, // Local path for now
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        let text = payload.text ?? "";

        // Protect <think> tags from table conversion
        const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
        const thinks: string[] = [];
        text = text.replace(thinkRegex, (match: string) => {
          thinks.push(match);
          return `__THINK_PLACEHOLDER_${thinks.length - 1}__`;
        });

        // [A2UI] Detect template_card JSON output from Agent
        const trimmedText = text.trim();
        if (trimmedText.startsWith("{") && trimmedText.includes('"template_card"')) {
          try {
            const parsed = JSON.parse(trimmedText);
            if (parsed.template_card) {
              const isSingleChat = msg.chattype !== "group";
              const responseUrl = getActiveReplyUrl(streamId);

              if (responseUrl && isSingleChat) {
                // 单聊且有 response_url：发送卡片
                await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
                  const res = await wecomFetch(
                    responseUrl,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        msgtype: "template_card",
                        template_card: parsed.template_card,
                      }),
                    },
                    { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
                  );
                  if (!res.ok) {
                    throw new Error(`template_card send failed: ${res.status}`);
                  }
                });
                logVerbose(target, `sent template_card: task_id=${parsed.template_card.task_id}`);
                streamStore.updateStream(streamId, (s) => {
                  s.finished = true;
                  s.content = "[已发送交互卡片]";
                });
                target.statusSink?.({ lastOutboundAt: Date.now() });
                return;
              } else {
                // 群聊 或 无 response_url：降级为文本描述
                logVerbose(target, `template_card fallback to text (group=${!isSingleChat}, hasUrl=${!!responseUrl})`);
                const cardTitle = parsed.template_card.main_title?.title || "交互卡片";
                const cardDesc = parsed.template_card.main_title?.desc || "";
                const buttons = parsed.template_card.button_list?.map((b: any) => b.text).join(" / ") || "";
                text = `📋 **${cardTitle}**${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
              }
            }
          } catch { /* parse fail, use normal text */ }
        }

        text = core.channel.text.convertMarkdownTables(text, tableMode);

        // Restore <think> tags
        thinks.forEach((think, i) => {
          text = text.replace(`__THINK_PLACEHOLDER_${i}__`, think);
        });

        const current = streamStore.getStream(streamId);
        if (!current) return;

        if (!current.images) current.images = [];

        const mediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);
        for (const mediaPath of mediaUrls) {
          try {
            let buf: Buffer;
            let contentType: string | undefined;
            let filename: string;

            const looksLikeUrl = /^https?:\/\//i.test(mediaPath);

            if (looksLikeUrl) {
              const loaded = await core.channel.media.fetchRemoteMedia({ url: mediaPath });
              buf = loaded.buffer;
              contentType = loaded.contentType;
              filename = loaded.fileName ?? "attachment";
            } else {
              const fs = await import("node:fs/promises");
              const pathModule = await import("node:path");
              buf = await fs.readFile(mediaPath);
              filename = pathModule.basename(mediaPath);
              const ext = pathModule.extname(mediaPath).slice(1).toLowerCase();
              const imageExts: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
              contentType = imageExts[ext] ?? "application/octet-stream";
            }

            if (contentType?.startsWith("image/")) {
              const base64 = buf.toString("base64");
              const md5 = crypto.createHash("md5").update(buf).digest("hex");
              current.images.push({ base64, md5 });
            } else {
              text += `\n\n[File: ${filename}]`;
            }
          } catch (err) {
            target.runtime.error?.(`Failed to process outbound media: ${mediaPath}: ${String(err)}`);
          }
        }

        const nextText = current.content
          ? `${current.content}\n\n${text}`.trim()
          : text.trim();

        streamStore.updateStream(streamId, (s) => {
          s.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
          if (current.images?.length) s.images = current.images; // ensure images are saved
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  streamStore.markFinished(streamId);
}

function formatQuote(quote: WecomInboundQuote): string {
  const type = quote.msgtype ?? "";
  if (type === "text") return quote.text?.content || "";
  if (type === "image") return `[引用: 图片] ${quote.image?.url || ""}`;
  if (type === "mixed" && quote.mixed?.msg_item) {
    const items = quote.mixed.msg_item.map((item) => {
      if (item.msgtype === "text") return item.text?.content;
      if (item.msgtype === "image") return `[图片] ${item.image?.url || ""}`;
      return "";
    }).filter(Boolean).join(" ");
    return `[引用: 图文] ${items}`;
  }
  if (type === "voice") return `[引用: 语音] ${quote.voice?.content || ""}`;
  if (type === "file") return `[引用: 文件] ${quote.file?.url || ""}`;
  return "";
}

function buildInboundBody(msg: WecomInboundMessage): string {
  let body = "";
  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  if (msgtype === "text") body = (msg as any).text?.content || "";
  else if (msgtype === "voice") body = (msg as any).voice?.content || "[voice]";
  else if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      body = items.map((item: any) => {
        const t = String(item?.msgtype ?? "").toLowerCase();
        if (t === "text") return item?.text?.content || "";
        if (t === "image") return `[image] ${item?.image?.url || ""}`;
        return `[${t || "item"}]`;
      }).filter(Boolean).join("\n");
    } else body = "[mixed]";
  } else if (msgtype === "image") body = `[image] ${(msg as any).image?.url || ""}`;
  else if (msgtype === "file") body = `[file] ${(msg as any).file?.url || ""}`;
  else if (msgtype === "event") body = `[event] ${(msg as any).event?.eventtype || ""}`;
  else if (msgtype === "stream") body = `[stream_refresh] ${(msg as any).stream?.id || ""}`;
  else body = msgtype ? `[${msgtype}]` : "";

  const quote = (msg as any).quote;
  if (quote) {
    const quoteText = formatQuote(quote).trim();
    if (quoteText) body += `\n\n> ${quoteText}`;
  }
  return body;
}

/**
 * **registerWecomWebhookTarget (注册 Webhook 目标)**
 * 
 * 注册一个 Bot 模式的接收端点。
 * 同时会触发清理定时器的检查（如果有新注册，确保定时器运行）。
 * 返回一个注销函数。
 */
export function registerWecomWebhookTarget(target: WecomWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, normalizedTarget]);
  ensurePruneTimer();
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
    checkPruneTimer();
  };
}

/**
 * 注册 Agent 模式 Webhook Target
 */
export function registerAgentWebhookTarget(target: AgentWebhookTarget): () => void {
  const key = WEBHOOK_PATHS.AGENT;
  agentTargets.set(key, target);
  ensurePruneTimer();
  return () => {
    agentTargets.delete(key);
    checkPruneTimer();
  };
}

/**
 * **handleWecomWebhookRequest (HTTP 请求入口)**
 * 
 * 处理来自企业微信的所有 Webhook 请求。
 * 职责：
 * 1. 路由分发：区分 Agent 模式 (`/wecom/agent`) 和 Bot 模式 (其他路径)。
 * 2. 安全校验：验证企业微信签名 (Signature)。
 * 3. 消息解密：处理企业微信的加密包。
 * 4. 响应处理：
 *    - GET 请求：处理 EchoStr 验证。
 *    - POST 请求：接收消息，放入 StreamStore，返回流式 First Chunk。
 */
export async function handleWecomWebhookRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = resolvePath(req);

  // Agent 模式路由: /wecom/agent
  if (path === WEBHOOK_PATHS.AGENT) {
    const agentTarget = agentTargets.get(WEBHOOK_PATHS.AGENT);
    if (agentTarget) {
      const core = getWecomRuntime();
      return handleAgentWebhook({
        req,
        res,
        agent: agentTarget.agent,
        config: agentTarget.config,
        core,
        log: agentTarget.runtime.log,
        error: agentTarget.runtime.error,
      });
    }
    // 未注册 Agent，返回 404
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`agent not configured - Agent 模式未配置，请运行 openclaw onboarding${ERROR_HELP}`);
    return true;
  }

  // Bot 模式路由: /wecom, /wecom/bot
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    const target = targets.find(c => c.account.token && verifyWecomSignature({ token: c.account.token, timestamp, nonce, encrypt: echostr, signature }));
    if (!target || !target.account.encodingAESKey) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`unauthorized - Bot 签名验证失败，请检查 Token 配置${ERROR_HELP}`);
      return true;
    }
    try {
      const plain = decryptWecomEncrypted({ encodingAESKey: target.account.encodingAESKey, receiveId: target.account.receiveId, encrypt: echostr });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`decrypt failed - 解密失败，请检查 EncodingAESKey${ERROR_HELP}`);
      return true;
    }
  }

  if (req.method !== "POST") return false;

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = 400;
    res.end(body.error || "invalid payload");
    return true;
  }
  const record = body.value as any;
  const encrypt = String(record?.encrypt ?? record?.Encrypt ?? "");
  const target = targets.find(c => c.account.token && verifyWecomSignature({ token: c.account.token, timestamp, nonce, encrypt, signature }));
  if (!target || !target.account.configured || !target.account.encodingAESKey) {
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`unauthorized - Bot 签名验证失败${ERROR_HELP}`);
    return true;
  }

  let plain: string;
  try {
    plain = decryptWecomEncrypted({ encodingAESKey: target.account.encodingAESKey, receiveId: target.account.receiveId, encrypt });
  } catch (err) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`decrypt failed - 解密失败${ERROR_HELP}`);
    return true;
  }

  const msg = parseWecomPlainMessage(plain);
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const proxyUrl = resolveWecomEgressProxyUrl(target.config);

  // Handle Event
  if (msgtype === "event") {
    const eventtype = String((msg as any).event?.eventtype ?? "").toLowerCase();

    if (eventtype === "template_card_event") {
      const msgid = msg.msgid ? String(msg.msgid) : undefined;

      // Dedupe: skip if already processed this event
      if (msgid && streamStore.getStreamByMsgId(msgid)) {
        logVerbose(target, `template_card_event: already processed msgid=${msgid}, skipping`);
        jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }));
        return true;
      }

      const cardEvent = (msg as any).event?.template_card_event;
      let interactionDesc = `[卡片交互] 按钮: ${cardEvent?.event_key || "unknown"}`;
      if (cardEvent?.selected_items?.selected_item?.length) {
        const selects = cardEvent.selected_items.selected_item.map((i: any) => `${i.question_key}=${i.option_ids?.option_id?.join(",")}`);
        interactionDesc += ` 选择: ${selects.join("; ")}`;
      }
      if (cardEvent?.task_id) interactionDesc += ` (任务ID: ${cardEvent.task_id})`;

      jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }));

      const streamId = streamStore.createStream({ msgid });
      streamStore.markStarted(streamId);
      storeActiveReply(streamId, msg.response_url);
      const core = getWecomRuntime();
      startAgentForStream({
        target: { ...target, core },
        accountId: target.account.accountId,
        msg: { ...msg, msgtype: "text", text: { content: interactionDesc } } as any,
        streamId,
      }).catch(err => target.runtime.error?.(`interaction failed: ${String(err)}`));
      return true;
    }

    if (eventtype === "enter_chat") {
      const welcome = target.account.config.welcomeText?.trim();
      jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: welcome ? { msgtype: "text", text: { content: welcome } } : {}, nonce, timestamp }));
      return true;
    }

    jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: {}, nonce, timestamp }));
    return true;
  }

  // Handle Stream Refresh
  if (msgtype === "stream") {
    const streamId = String((msg as any).stream?.id ?? "").trim();
    const state = streamStore.getStream(streamId);
    const reply = state ? buildStreamReplyFromState(state) : buildStreamReplyFromState({ streamId: streamId || "unknown", createdAt: Date.now(), updatedAt: Date.now(), started: true, finished: true, content: "" });
    jsonOk(res, buildEncryptedJsonReply({ account: target.account, plaintextJson: reply, nonce, timestamp }));
    return true;
  }

  // Handle Message (with Debounce)
  const userid = msg.from?.userid?.trim() || "unknown";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const pendingKey = `wecom:${target.account.accountId}:${userid}:${chatId}`;
  const msgContent = buildInboundBody(msg);

  // 去重: msgid if exists
  if (msg.msgid) {
    const existingStreamId = streamStore.getStreamByMsgId(String(msg.msgid));
    if (existingStreamId) {
      logVerbose(target, `message: 重复的 msgid=${msg.msgid}，跳过处理并返回占位符`);
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: buildStreamPlaceholderReply({
          streamId: existingStreamId,
          placeholderContent: target.account.config.streamPlaceholderContent
        }),
        nonce,
        timestamp
      }));
      return true;
    }
  }

  const { streamId, isNew } = streamStore.addPendingMessage({
    pendingKey,
    target,
    msg,
    msgContent,
    nonce,
    timestamp
  });

  if (isNew) {
    storeActiveReply(streamId, msg.response_url, proxyUrl);
  }

  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: buildStreamPlaceholderReply({
      streamId,
      placeholderContent: target.account.config.streamPlaceholderContent
    }),
    nonce,
    timestamp
  }));
  return true;
}

export async function sendActiveMessage(streamId: string, content: string): Promise<void> {
  await useActiveReplyOnce(streamId, async ({ responseUrl, proxyUrl }) => {
    const res = await wecomFetch(
      responseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content } }),
      },
      { proxyUrl, timeoutMs: LIMITS.REQUEST_TIMEOUT_MS },
    );
    if (!res.ok) {
      throw new Error(`active send failed: ${res.status}`);
    }
  });
}
