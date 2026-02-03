import type { ChannelOutboundAdapter, ChannelOutboundContext } from "openclaw/plugin-sdk";

import { sendText as sendAgentText, sendMedia as sendAgentMedia, uploadMedia } from "./agent/api-client.js";
import { resolveWecomAccounts } from "./config/index.js";
import { getWecomRuntime } from "./runtime.js";

import { resolveWecomTarget } from "./target.js";

function resolveAgentConfigOrThrow(cfg: ChannelOutboundContext["cfg"]) {
  const account = resolveWecomAccounts(cfg).agent;
  if (!account?.configured) {
    throw new Error(
      "WeCom outbound requires Agent mode. Configure channels.wecom.agent (corpId/corpSecret/agentId/token/encodingAESKey).",
    );
  }
  // 注意：不要在日志里输出 corpSecret 等敏感信息
  console.log(`[wecom-outbound] Using agent config: corpId=${account.corpId}, agentId=${account.agentId}`);
  return account;
}

export const wecomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunkerMode: "text",
  textChunkLimit: 20480,
  chunker: (text, limit) => {
    try {
      return getWecomRuntime().channel.text.chunkText(text, limit);
    } catch {
      return [text];
    }
  },
  sendText: async ({ cfg, to, text }: ChannelOutboundContext) => {
    // signal removed - not supported in current SDK

    const agent = resolveAgentConfigOrThrow(cfg);
    const target = resolveWecomTarget(to);
    if (!target) {
      throw new Error("WeCom outbound requires a target (userid, partyid, tagid or chatid).");
    }

    const { touser, toparty, totag, chatid } = target;
    if (chatid) {
      throw new Error(
        `企业微信（WeCom）Agent 主动发送不支持向群 chatId 发送（chatId=${chatid}）。` +
          `该路径在实际环境中经常失败（例如 86008：无权限访问该会话/会话由其他应用创建）。` +
          `请改为发送给用户（userid / user:xxx），或由 Bot 模式在群内交付。`,
      );
    }
    console.log(`[wecom-outbound] Sending text to target=${JSON.stringify(target)} (len=${text.length})`);

    try {
      await sendAgentText({
        agent,
        toUser: touser,
        toParty: toparty,
        toTag: totag,
        chatId: chatid,
        text,
      });
      console.log(`[wecom-outbound] Successfully sent text to ${JSON.stringify(target)}`);
    } catch (err) {
      console.error(`[wecom-outbound] Failed to send text to ${JSON.stringify(target)}:`, err);
      throw err;
    }

    return {
      channel: "wecom",
      messageId: `agent-${Date.now()}`,
      timestamp: Date.now(),
    };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl }: ChannelOutboundContext) => {
    // signal removed - not supported in current SDK

    const agent = resolveAgentConfigOrThrow(cfg);
    const target = resolveWecomTarget(to);
    if (!target) {
      throw new Error("WeCom outbound requires a target (userid, partyid, tagid or chatid).");
    }
    if (target.chatid) {
      throw new Error(
        `企业微信（WeCom）Agent 主动发送不支持向群 chatId 发送（chatId=${target.chatid}）。` +
          `该路径在实际环境中经常失败（例如 86008：无权限访问该会话/会话由其他应用创建）。` +
          `请改为发送给用户（userid / user:xxx），或由 Bot 模式在群内交付。`,
      );
    }
    if (!mediaUrl) {
      throw new Error("WeCom outbound requires mediaUrl.");
    }

    let buffer: Buffer;
    let contentType: string;
    let filename: string;

    // 判断是 URL 还是本地文件路径
    const isRemoteUrl = /^https?:\/\//i.test(mediaUrl);

    if (isRemoteUrl) {
      const res = await fetch(mediaUrl, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        throw new Error(`Failed to download media: ${res.status}`);
      }
      buffer = Buffer.from(await res.arrayBuffer());
      contentType = res.headers.get("content-type") || "application/octet-stream";
      const urlPath = new URL(mediaUrl).pathname;
      filename = urlPath.split("/").pop() || "media";
    } else {
      // 本地文件路径
      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      buffer = await fs.readFile(mediaUrl);
      filename = path.basename(mediaUrl);

      // 根据扩展名推断 content-type
      const ext = path.extname(mediaUrl).slice(1).toLowerCase();
      const mimeTypes: Record<string, string> = {
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
        webp: "image/webp", bmp: "image/bmp", mp3: "audio/mpeg", wav: "audio/wav",
        amr: "audio/amr", mp4: "video/mp4", pdf: "application/pdf", doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      };
      contentType = mimeTypes[ext] || "application/octet-stream";
      console.log(`[wecom-outbound] Reading local file: ${mediaUrl}, ext=${ext}, contentType=${contentType}`);
    }

    let mediaType: "image" | "voice" | "video" | "file" = "file";
    if (contentType.startsWith("image/")) mediaType = "image";
    else if (contentType.startsWith("audio/")) mediaType = "voice";
    else if (contentType.startsWith("video/")) mediaType = "video";

    const mediaId = await uploadMedia({
      agent,
      type: mediaType,
      buffer,
      filename,
    });

    const { touser, toparty, totag, chatid } = target;
    console.log(`[wecom-outbound] Sending media (${mediaType}) to ${JSON.stringify(target)} (mediaId=${mediaId})`);

    try {
      await sendAgentMedia({
        agent,
        toUser: touser,
        toParty: toparty,
        toTag: totag,
        chatId: chatid,
        mediaId,
        mediaType,
        ...(mediaType === "video" && text?.trim()
          ? {
            title: text.trim().slice(0, 64),
            description: text.trim().slice(0, 512),
          }
          : {}),
      });
      console.log(`[wecom-outbound] Successfully sent media to ${JSON.stringify(target)}`);
    } catch (err) {
      console.error(`[wecom-outbound] Failed to send media to ${JSON.stringify(target)}:`, err);
      throw err;
    }

    return {
      channel: "wecom",
      messageId: `agent-media-${Date.now()}`,
      timestamp: Date.now(),
    };
  },
};
