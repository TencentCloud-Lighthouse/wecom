import crypto from "node:crypto";
import type { StreamState, PendingInbound, ActiveReplyState, WecomWebhookTarget } from "./types.js";
import type { WecomInboundMessage } from "../types.js";

// Constants
export const LIMITS = {
    STREAM_TTL_MS: 10 * 60 * 1000,
    ACTIVE_REPLY_TTL_MS: 60 * 60 * 1000,
    DEFAULT_DEBOUNCE_MS: 500,
    STREAM_MAX_BYTES: 20_480,
    REQUEST_TIMEOUT_MS: 15_000
};

/**
 * **StreamStore (流状态会话存储)**
 * 
 * 管理企业微信回调的流式会话状态、消息去重和防抖聚合逻辑。
 * 负责维护 msgid 到 streamId 的映射，以及临时缓存待处理的 Pending 消息。
 */
export class StreamStore {
    private streams = new Map<string, StreamState>();
    private msgidToStreamId = new Map<string, string>();
    private pendingInbounds = new Map<string, PendingInbound>();
    private onFlush?: (pending: PendingInbound) => void;

    /**
     * **setFlushHandler (设置防抖刷新回调)**
     * 
     * 当防抖计时器结束时调用的处理函数。通常用于触发 Agent 进行消息处理。
     * @param handler 回调函数，接收聚合后的 PendingInbound 对象
     */
    public setFlushHandler(handler: (pending: PendingInbound) => void) {
        this.onFlush = handler;
    }

    /**
     * **createStream (创建流会话)**
     * 
     * 初始化一个新的流式会话状态。
     * @param params.msgid (可选) 企业微信消息 ID，用于后续去重映射
     * @returns 生成的 streamId (Hex 字符串)
     */
    createStream(params: { msgid?: string }): string {
        const streamId = crypto.randomBytes(16).toString("hex");

        if (params.msgid) {
            this.msgidToStreamId.set(String(params.msgid), streamId);
        }

        this.streams.set(streamId, {
            streamId,
            msgid: params.msgid,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            started: false,
            finished: false,
            content: ""
        });

        return streamId;
    }

    /**
     * **getStream (获取流状态)**
     * 
     * 根据 streamId 获取当前的会话状态。
     * @param streamId 流会话 ID
     */
    getStream(streamId: string): StreamState | undefined {
        return this.streams.get(streamId);
    }

    /**
     * **getStreamByMsgId (通过 msgid 查找流 ID)**
     * 
     * 用于消息去重：检查该 msgid 是否已经关联由正在进行或已完成的流会话。
     * @param msgid 企业微信消息 ID
     */
    getStreamByMsgId(msgid: string): string | undefined {
        return this.msgidToStreamId.get(String(msgid));
    }

    /**
     * **updateStream (更新流状态)**
     * 
     * 原子更新流状态，并自动刷新 updatedAt 时间戳。
     * @param streamId 流会话 ID
     * @param mutator 状态修改函数
     */
    updateStream(streamId: string, mutator: (state: StreamState) => void): void {
        const state = this.streams.get(streamId);
        if (state) {
            mutator(state);
            state.updatedAt = Date.now();
        }
    }

    /**
     * **markStarted (标记流开始)**
     * 
     * 标记该流会话已经开始处理（通常在 Agent 启动后调用）。
     */
    markStarted(streamId: string): void {
        this.updateStream(streamId, (s) => { s.started = true; });
    }

    /**
     * **markFinished (标记流结束)**
     * 
     * 标记该流会话已完成，不再接收内容更新。
     */
    markFinished(streamId: string): void {
        this.updateStream(streamId, (s) => { s.finished = true; });
    }

    /**
     * **addPendingMessage (添加待处理消息 / 防抖聚合)**
     * 
     * 将收到的消息加入待处理队列。如果相同 pendingKey 已存在，则是防抖聚合；否则创建新条目。
     * 会自动设置或重置防抖定时器。
     * 
     * @param params 消息参数
     * @returns { streamId, isNew } isNew=true 表示这是新的一组消息，需初始化 ActiveReply
     */
    addPendingMessage(params: {
        pendingKey: string;
        target: WecomWebhookTarget;
        msg: WecomInboundMessage;
        msgContent: string;
        nonce: string;
        timestamp: string;
        debounceMs?: number;
    }): { streamId: string; isNew: boolean } {
        const { pendingKey, target, msg, msgContent, nonce, timestamp, debounceMs } = params;
        const effectiveDebounceMs = debounceMs ?? LIMITS.DEFAULT_DEBOUNCE_MS;
        const existing = this.pendingInbounds.get(pendingKey);

        if (existing) {
            existing.contents.push(msgContent);
            if (msg.msgid) existing.msgids.push(msg.msgid);
            if (existing.timeout) clearTimeout(existing.timeout);

            // 重置定时器 (Debounce)
            existing.timeout = setTimeout(() => {
                this.flushPending(pendingKey);
            }, effectiveDebounceMs);

            return { streamId: existing.streamId, isNew: false };
        }

        // 创建新的聚合分组
        const streamId = this.createStream({ msgid: msg.msgid });
        const pending: PendingInbound = {
            streamId,
            target,
            msg,
            contents: [msgContent],
            msgids: msg.msgid ? [msg.msgid] : [],
            nonce,
            timestamp,
            createdAt: Date.now(),
            timeout: setTimeout(() => {
                this.flushPending(pendingKey);
            }, effectiveDebounceMs)
        };
        this.pendingInbounds.set(pendingKey, pending);
        return { streamId, isNew: true };
    }

    /**
     * **flushPending (触发消息处理)**
     * 
     * 内部方法：防抖时间结束后，将聚合的消息一次性推送给 flushHandler。
     */
    private flushPending(pendingKey: string): void {
        const pending = this.pendingInbounds.get(pendingKey);
        if (!pending) return;

        this.pendingInbounds.delete(pendingKey);
        if (pending.timeout) {
            clearTimeout(pending.timeout);
            pending.timeout = null;
        }

        if (this.onFlush) {
            this.onFlush(pending);
        }
    }

    /**
     * **prune (清理过期状态)**
     * 
     * 清理过期的流会话、msgid 映射以及残留的 Pending 消息。
     * @param now 当前时间戳 (毫秒)
     */
    prune(now: number = Date.now()): void {
        const streamCutoff = now - LIMITS.STREAM_TTL_MS;

        // 清理过期的流会话
        for (const [id, state] of this.streams.entries()) {
            if (state.updatedAt < streamCutoff) {
                this.streams.delete(id);
                if (state.msgid) {
                    // 如果 msgid 映射仍指向该 stream，则一并移除
                    if (this.msgidToStreamId.get(state.msgid) === id) {
                        this.msgidToStreamId.delete(state.msgid);
                    }
                }
            }
        }

        // 清理悬空的 msgid 映射 (Double check)
        for (const [msgid, id] of this.msgidToStreamId.entries()) {
            if (!this.streams.has(id)) {
                this.msgidToStreamId.delete(msgid);
            }
        }

        // 清理超时的 Pending 消息 (通常由 timeout 清理，此处作为兜底)
        for (const [key, pending] of this.pendingInbounds.entries()) {
            if (now - pending.createdAt > LIMITS.STREAM_TTL_MS) {
                if (pending.timeout) clearTimeout(pending.timeout);
                this.pendingInbounds.delete(key);
            }
        }
    }
}

/**
 * **ActiveReplyStore (主动回复地址存储)**
 * 
 * 管理企业微信回调中的 `response_url` (用于被动回复转主动推送) 和 `proxyUrl`。
 * 支持 'once' (一次性) 或 'multi' (多次) 使用策略。
 */
export class ActiveReplyStore {
    private activeReplies = new Map<string, ActiveReplyState>();

    /**
     * @param policy 使用策略: "once" (默认，销毁式) 或 "multi"
     */
    constructor(private policy: "once" | "multi" = "once") { }

    /**
     * **store (存储回复地址)**
     * 
     * 关联 streamId 与 response_url。
     */
    store(streamId: string, responseUrl?: string, proxyUrl?: string): void {
        const url = responseUrl?.trim();
        if (!url) return;
        this.activeReplies.set(streamId, { response_url: url, proxyUrl, createdAt: Date.now() });
    }

    /**
     * **getUrl (获取回复地址)**
     * 
     * 获取指定 streamId 关联的 response_url。
     */
    getUrl(streamId: string): string | undefined {
        return this.activeReplies.get(streamId)?.response_url;
    }

    /**
     * **use (消耗回复地址)**
     * 
     * 使用存储的 response_url 执行操作。
     * - 如果策略是 "once"，第二次调用会抛错。
     * - 自动更新使用时间 (usedAt)。
     * 
     * @param streamId 流会话 ID
     * @param fn 执行函数，接收 { responseUrl, proxyUrl }
     */
    async use(streamId: string, fn: (params: { responseUrl: string; proxyUrl?: string }) => Promise<void>): Promise<void> {
        const state = this.activeReplies.get(streamId);
        if (!state?.response_url) {
            return; // 无 URL 可用，安全跳过
        }

        if (this.policy === "once" && state.usedAt) {
            throw new Error(`response_url already used for stream ${streamId} (Policy: once)`);
        }

        try {
            await fn({ responseUrl: state.response_url, proxyUrl: state.proxyUrl });
            state.usedAt = Date.now();
        } catch (err: unknown) {
            state.lastError = err instanceof Error ? err.message : String(err);
            throw err;
        }
    }

    /**
     * **prune (清理过期地址)**
     * 
     * 清理超过 TTL 的 active reply 记录。
     */
    prune(now: number = Date.now()): void {
        const cutoff = now - LIMITS.ACTIVE_REPLY_TTL_MS;
        for (const [id, state] of this.activeReplies.entries()) {
            if (state.createdAt < cutoff) {
                this.activeReplies.delete(id);
            }
        }
    }
}

/**
 * **MonitorState (全局监控状态容器)**
 * 
 * 模块单例，统一管理 StreamStore 和 ActiveReplyStore 实例。
 * 提供生命周期方法 (startPruning / stopPruning) 以自动清理过期数据。
 */
class MonitorState {
    /** 主要的流状态存储 */
    public readonly streamStore = new StreamStore();
    /** 主动回复地址存储 */
    public readonly activeReplyStore = new ActiveReplyStore("multi");

    private pruneInterval?: NodeJS.Timeout;

    /**
     * **startPruning (启动自动清理)**
     * 
     * 启动定时器，定期清理过期的流和回复地址。应在插件有活跃 Target 时调用。
     * @param intervalMs 清理间隔 (默认 60s)
     */
    public startPruning(intervalMs: number = 60_000): void {
        if (this.pruneInterval) return;
        this.pruneInterval = setInterval(() => {
            const now = Date.now();
            this.streamStore.prune(now);
            this.activeReplyStore.prune(now);
        }, intervalMs);
    }

    /**
     * **stopPruning (停止自动清理)**
     * 
     * 停止定时器。应在插件无活跃 Target 时调用以释放资源。
     */
    public stopPruning(): void {
        if (this.pruneInterval) {
            clearInterval(this.pruneInterval);
            this.pruneInterval = undefined;
        }
    }
}

/**
 * **monitorState (全局单例)**
 * 
 * 导出全局唯一的 MonitorState 实例，供整个应用共享状态。
 */
export const monitorState = new MonitorState();
