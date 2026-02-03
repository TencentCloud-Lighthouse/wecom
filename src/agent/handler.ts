/**
 * WeCom Agent Webhook 处理器
 * 处理 XML 格式回调
 */

import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import type { ResolvedAgentAccount } from "../types/index.js";
import { LIMITS } from "../types/constants.js";
import { decryptWecomEncrypted, verifyWecomSignature, computeWecomMsgSignature, encryptWecomPlaintext } from "../crypto/index.js";
import { extractEncryptFromXml, buildEncryptedXmlResponse } from "../crypto/xml.js";
import { parseXml, extractMsgType, extractFromUser, extractContent, extractChatId, extractMediaId } from "../shared/xml-parser.js";
import { sendText, downloadMedia } from "./api-client.js";
import { getWecomRuntime } from "../runtime.js";
import type { WecomAgentInboundMessage } from "../types/index.js";

/** 错误提示信息 */
const ERROR_HELP = "\n\n遇到问题？联系作者: YanHaidao (微信: YanHaidao)";

/**
 * **AgentWebhookParams (Webhook 处理器参数)**
 * 
 * 传递给 Agent Webhook 处理函数的上下文参数集合。
 * @property req Node.js 原始请求对象
 * @property res Node.js 原始响应对象
 * @property agent 解析后的 Agent 账号信息
 * @property config 全局插件配置
 * @property core OpenClaw 插件运行时
 * @property log 可选日志输出函数
 * @property error 可选错误输出函数
 */
export type AgentWebhookParams = {
    req: IncomingMessage;
    res: ServerResponse;
    agent: ResolvedAgentAccount;
    config: OpenClawConfig;
    core: PluginRuntime;
    log?: (msg: string) => void;
    error?: (msg: string) => void;
};

/**
 * **resolveQueryParams (解析查询参数)**
 * 
 * 辅助函数：从 IncomingMessage 中解析 URL 查询字符串，用于获取签名、时间戳等参数。
 */
function resolveQueryParams(req: IncomingMessage): URLSearchParams {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams;
}

/**
 * **readRawBody (读取原始请求体)**
 * 
 * 异步读取 HTTP POST 请求的原始 BODY 数据（XML 字符串）。
 * 包含最大体积限制检查，防止内存溢出攻击。
 */
async function readRawBody(req: IncomingMessage, maxSize: number = LIMITS.MAX_REQUEST_BODY_SIZE): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxSize) {
                reject(new Error("Request body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            resolve(Buffer.concat(chunks).toString("utf8"));
        });

        req.on("error", reject);
    });
}

/**
 * **handleUrlVerification (处理 URL 验证)**
 * 
 * 处理企业微信 Agent 配置时的 GET 请求验证。
 * 流程：
 * 1. 验证 msg_signature 签名。
 * 2. 解密 echostr 参数。
 * 3. 返回解密后的明文 echostr。
 */
async function handleUrlVerification(
    req: IncomingMessage,
    res: ServerResponse,
    agent: ResolvedAgentAccount,
): Promise<boolean> {
    const query = resolveQueryParams(req);
    const timestamp = query.get("timestamp") ?? "";
    const nonce = query.get("nonce") ?? "";
    const echostr = query.get("echostr") ?? "";
    const signature = query.get("msg_signature") ?? "";

    const valid = verifyWecomSignature({
        token: agent.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
    });

    if (!valid) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(`unauthorized - 签名验证失败，请检查 Token 配置${ERROR_HELP}`);
        return true;
    }

    try {
        const plain = decryptWecomEncrypted({
            encodingAESKey: agent.encodingAESKey,
            receiveId: agent.corpId,
            encrypt: echostr,
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(plain);
        return true;
    } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(`decrypt failed - 解密失败，请检查 EncodingAESKey 配置${ERROR_HELP}`);
        return true;
    }
}

/**
 * 处理消息回调 (POST)
 */
async function handleMessageCallback(params: AgentWebhookParams): Promise<boolean> {
    const { req, res, agent, config, core, log, error } = params;

    try {
        const rawXml = await readRawBody(req);
        const encrypted = extractEncryptFromXml(rawXml);

        const query = resolveQueryParams(req);
        const timestamp = query.get("timestamp") ?? "";
        const nonce = query.get("nonce") ?? "";
        const signature = query.get("msg_signature") ?? "";

        // 验证签名
        const valid = verifyWecomSignature({
            token: agent.token,
            timestamp,
            nonce,
            encrypt: encrypted,
            signature,
        });

        if (!valid) {
            res.statusCode = 401;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(`unauthorized - 签名验证失败${ERROR_HELP}`);
            return true;
        }

        // 解密
        const decrypted = decryptWecomEncrypted({
            encodingAESKey: agent.encodingAESKey,
            receiveId: agent.corpId,
            encrypt: encrypted,
        });

        // 解析 XML
        const msg = parseXml(decrypted);
        const msgType = extractMsgType(msg);
        const fromUser = extractFromUser(msg);
        const chatId = extractChatId(msg);
        const content = extractContent(msg);

        log?.(`[wecom-agent] ${msgType} from=${fromUser} chatId=${chatId ?? "N/A"} content=${content.slice(0, 100)}`);

        // 先返回 success (Agent 模式使用 API 发送回复，不用被动回复)
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("success");

        // 异步处理消息
        processAgentMessage({
            agent,
            config,
            core,
            fromUser,
            chatId,
            msgType,
            content,
            msg,
            log,
            error,
        }).catch((err) => {
            error?.(`[wecom-agent] process failed: ${String(err)}`);
        });

        return true;
    } catch (err) {
        error?.(`[wecom-agent] callback failed: ${String(err)}`);
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(`error - 回调处理失败${ERROR_HELP}`);
        return true;
    }
}

/**
 * **processAgentMessage (处理 Agent 消息)**
 * 
 * 异步处理解密后的消息内容，并触发 OpenClaw Agent。
 * 流程：
 * 1. 路由解析：根据 userid或群ID 确定 Agent 路由。
 * 2. 媒体处理：如果是图片/文件等，下载资源。
 * 3. 上下文构建：创建 Inbound Context。
 * 4. 会话记录：更新 Session 状态。
 * 5. 调度回复：将 Agent 的响应通过 `api-client` 发送回企业微信。
 */
async function processAgentMessage(params: {
    agent: ResolvedAgentAccount;
    config: OpenClawConfig;
    core: PluginRuntime;
    fromUser: string;
    chatId?: string;
    msgType: string;
    content: string;
    msg: WecomAgentInboundMessage;
    log?: (msg: string) => void;
    error?: (msg: string) => void;
}): Promise<void> {
    const { agent, config, core, fromUser, chatId, content, msg, msgType, log, error } = params;

    const isGroup = Boolean(chatId);
    const peerId = isGroup ? chatId! : fromUser;

    // 处理媒体文件
    const attachments: any[] = []; // TODO: define specific type
    let finalContent = content;
    let mediaPath: string | undefined;
    let mediaType: string | undefined;

    if (["image", "voice", "video", "file"].includes(msgType)) {
        const mediaId = extractMediaId(msg);
        if (mediaId) {
            try {
                log?.(`[wecom-agent] downloading media: ${mediaId} (${msgType})`);
                const { buffer, contentType } = await downloadMedia({ agent, mediaId });

                // 推断文件名后缀
                const extMap: Record<string, string> = {
                    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
                    "audio/amr": "amr", "audio/speex": "speex", "video/mp4": "mp4",
                };
                const ext = extMap[contentType] || "bin";
                const filename = `${mediaId}.${ext}`;

                // 使用 Core SDK 保存媒体文件
                const saved = await core.channel.media.saveMediaBuffer(
                    buffer,
                    contentType,
                    "inbound", // context/scope
                    LIMITS.MAX_REQUEST_BODY_SIZE, // limit
                    filename
                );

                log?.(`[wecom-agent] media saved to: ${saved.path}`);
                mediaPath = saved.path;
                mediaType = contentType;

                // 构建附件
                attachments.push({
                    name: filename,
                    mimeType: contentType,
                    url: pathToFileURL(saved.path).href, // 使用跨平台安全的文件 URL
                });

                // 更新文本提示
                finalContent = `${content} (已下载 ${buffer.length} 字节)`;
            } catch (err) {
                error?.(`[wecom-agent] media download failed: ${String(err)}`);
                finalContent = `${content} (媒体下载失败)`;
            }
        } else {
            error?.(`[wecom-agent] mediaId not found for ${msgType}`);
        }
    }

    // 解析路由
    const route = core.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: "wecom",
        accountId: agent.accountId,
        peer: { kind: isGroup ? "group" : "dm", id: peerId },
    });

    // 构建上下文
    const fromLabel = isGroup ? `group:${peerId}` : `user:${fromUser}`;
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
        body: finalContent,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: finalContent,
        CommandBody: finalContent,
        Attachments: attachments.length > 0 ? attachments : undefined,
        From: isGroup ? `wecom:group:${peerId}` : `wecom:${fromUser}`,
        To: `wecom:${peerId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: fromLabel,
        SenderName: fromUser,
        SenderId: fromUser,
        Provider: "wecom",
        Surface: "wecom",
        OriginatingChannel: "wecom",
        OriginatingTo: `wecom:${peerId}`,
        CommandAuthorized: true, // 已通过 WeCom 签名验证
        MediaPath: mediaPath,
        MediaType: mediaType,
        MediaUrl: mediaPath,
    });

    // 记录会话
    await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
            error?.(`[wecom-agent] session record failed: ${String(err)}`);
        },
    });

    // 调度回复
    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
            deliver: async (payload: { text?: string }, info: { kind: string }) => {
                const text = payload.text ?? "";
                if (!text) return;

                try {
                    await sendText({
                        agent,
                        toUser: fromUser,
                        chatId: isGroup ? chatId : undefined,
                        text,
                    });
                    log?.(`[wecom-agent] reply delivered (${info.kind}) to ${fromUser}`);
                } catch (err: unknown) {
                    error?.(`[wecom-agent] reply failed: ${String(err)}`);
                }
            },
            onError: (err: unknown, info: { kind: string }) => {
                error?.(`[wecom-agent] ${info.kind} reply error: ${String(err)}`);
            },
        },
        replyOptions: {
            disableBlockStreaming: true,
        },
    });
}

/**
 * **handleAgentWebhook (Agent Webhook 入口)**
 * 
 * 统一处理 Agent 模式的 Webhook 请求。
 * 根据 HTTP 方法分发到 URL 验证 (GET) 或 消息处理 (POST)。
 */
export async function handleAgentWebhook(params: AgentWebhookParams): Promise<boolean> {
    const { req } = params;

    if (req.method === "GET") {
        return handleUrlVerification(req, params.res, params.agent);
    }

    if (req.method === "POST") {
        return handleMessageCallback(params);
    }

    return false;
}
