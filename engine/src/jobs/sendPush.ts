import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "../lib/prisma.ts";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { isOnline } from "../realtime/presence.ts";

export interface PushJob {
  recipientId: string;
  senderId: string;
  senderUsername: string;
  preview: string;
  /** Group messages are titled with the group name and open the group chat. */
  groupId?: string;
  groupName?: string;
}

/** The parts of the Expo SDK we use, so tests can pass a fake. */
export interface PushClient {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

const expo: PushClient = new Expo({ accessToken: env.EXPO_ACCESS_TOKEN });

export async function sendPush(job: PushJob, client: PushClient = expo) {
  // The job is delayed a few seconds; if the user opened the app meanwhile, the socket already delivered it.
  if (await isOnline(job.recipientId)) return { skipped: "online" };

  const tokens = await prisma.pushToken.findMany({ where: { userId: job.recipientId }, select: { token: true } });
  const valid = tokens.map((t) => t.token).filter((t) => Expo.isExpoPushToken(t));
  if (valid.length === 0) return { skipped: "no-tokens" };

  const messages: ExpoPushMessage[] = valid.map((to) => ({
    to,
    sound: "default",
    title: job.groupName ?? `@${job.senderUsername}`,
    body: job.groupId ? `@${job.senderUsername}: ${job.preview}` : job.preview,
    data: { type: "message", from: job.senderId, ...(job.groupId ? { groupId: job.groupId } : {}) },
    channelId: "messages",
    // Groups notifications per chat on iOS.
    threadId: job.groupId ?? job.senderId,
  }));

  let sent = 0;
  for (const chunk of client.chunkPushNotifications(messages)) {
    const tickets = await client.sendPushNotificationsAsync(chunk);
    for (const [i, ticket] of tickets.entries()) {
      if (ticket.status === "ok") {
        sent++;
        continue;
      }
      logger.warn({ ticket }, "push ticket error");
      if (ticket.details?.error === "DeviceNotRegistered") {
        const to = chunk[i]?.to;
        if (typeof to === "string") await prisma.pushToken.deleteMany({ where: { token: to } });
      }
    }
  }
  return { sent };
}

export function previewFor(kind: "text" | "file", text: string | null, mime?: string) {
  if (kind === "file") {
    const label = mime?.startsWith("image/") ? "📷 Photo" : mime?.startsWith("video/") ? "🎥 Video" : mime?.startsWith("audio/") ? "🎵 Audio" : "📎 File";
    return text ? `${label}: ${text.slice(0, 80)}` : label;
  }
  const t = text ?? "";
  return t.length > 100 ? `${t.slice(0, 100)}…` : t;
}
