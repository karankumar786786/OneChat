import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import type { FileMeta, GroupMemberRow, MessageRow } from "../db/types";
import { nameColor } from "../lib/colors";
import { openImage } from "../ui/openImage";
import { getDb } from "../db";
import { setLocalUri } from "../db/queries";
import { emitDbChange } from "../db/changes";
import { downloadFile, isExpiredError } from "../files/download";
import { Ticks } from "../ui/components";
import { colors, radius, space } from "../ui/theme";
import { sizeLabel, timeLabel } from "../lib/format";

export function MessageBubble({ message: m, replied, replyName, sender, showSender, onSenderPress, myId, onLongPress }: {
  message: MessageRow;
  replied?: MessageRow;
  /** Name to show on a quoted message ("You", the peer, or the group member). */
  replyName: (m: MessageRow) => string;
  /** Group messages from others: who sent it. */
  sender?: GroupMemberRow | null;
  showSender?: boolean;
  onSenderPress?: (userId: string) => void;
  myId: string;
  onLongPress: () => void;
}) {
  if (m.kind === "system") {
    return (
      <View style={styles.systemWrap}>
        <Text style={styles.systemText}>{m.text}</Text>
      </View>
    );
  }

  const mine = m.fromMe === 1;
  const file = m.fileJson ? (JSON.parse(m.fileJson) as FileMeta) : null;
  const reactions = [m.peerReaction, m.otherReactions, m.myReaction].filter(Boolean).join("");
  const senderLabel = showSender && !mine ? (sender ? sender.displayName || `@${sender.username}` : "Former member") : null;

  return (
    <View style={[styles.wrap, mine ? styles.right : styles.left, reactions ? { marginBottom: space(3) } : null]}>
      <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
        {senderLabel ? (
          // Its own button (not nested text) so it is tappable and reachable with VoiceOver.
          <Pressable
            disabled={!m.senderId || !onSenderPress}
            onPress={() => m.senderId && onSenderPress?.(m.senderId)}
            accessibilityRole="button"
            accessibilityLabel={`Open profile of ${senderLabel}`}
            hitSlop={6}
          >
            <Text style={[styles.sender, { color: nameColor(m.senderId ?? "") }]}>{senderLabel}</Text>
          </Pressable>
        ) : null}
        <Pressable onLongPress={onLongPress} delayLongPress={250} style={{ gap: 4 }}>
        {m.forwarded && !m.deleted ? (
          <View style={styles.forwarded}>
            <Ionicons name="arrow-redo" size={12} color={mine ? colors.bubbleMeta : colors.muted} />
            <Text style={[styles.forwardedText, mine && { color: colors.bubbleMeta }]}>Forwarded</Text>
          </View>
        ) : null}
        {replied && !m.deleted ? (
          <View style={styles.quote}>
            <Text style={styles.quoteName}>{replyName(replied)}</Text>
            <Text style={styles.quoteText} numberOfLines={2}>{replied.deleted ? "Deleted message" : (replied.text ?? "📎 File")}</Text>
          </View>
        ) : null}

        {m.deleted ? (
          <Text style={[styles.deleted, mine && { color: colors.bubbleMeta }]}>{m.deleted === 2 ? "🚫 This message was deleted by an admin" : "🚫 This message was deleted"}</Text>
        ) : (
          <>
            {file ? <FilePart message={m} file={file} /> : null}
            {m.text ? <RichText text={m.text} highlight={mentionsMe(m, myId)} /> : null}
          </>
        )}

        <View style={styles.meta}>
          <Text style={[styles.time, mine && { color: colors.bubbleMeta }]}>{timeLabel(m.sentAt)}</Text>
          {mine ? <Ticks tick={m.tick} /> : null}
        </View>
        </Pressable>
      </View>
      {reactions ? (
        <View style={[styles.reactions, mine ? { right: space(2) } : { left: space(2) }]}>
          <Text style={{ fontSize: 13 }}>{reactions}</Text>
        </View>
      ) : null}
    </View>
  );
}

function mentionsMe(m: MessageRow, myId: string) {
  try {
    return Boolean(m.mentionsJson && (JSON.parse(m.mentionsJson) as string[]).includes(myId));
  } catch {
    return false;
  }
}

/** Message text with @mentions in bold colour. */
function RichText({ text, highlight }: { text: string; highlight: boolean }) {
  const parts = text.split(/(@[a-z0-9_.]{3,20})/gi);
  return (
    <Text style={[styles.text, highlight && styles.mentionedMe]}>
      {parts.map((p, i) =>
        /^@[a-z0-9_.]{3,20}$/i.test(p) ? (
          <Text key={i} style={styles.mention}>{p}</Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

function FilePart({ message: m, file }: { message: MessageRow; file: FileMeta }) {
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(Boolean(file.expiresAt && new Date(file.expiresAt) < new Date() && !m.localUri));
  const isImage = file.mime.startsWith("image/");

  async function open() {
    if (busy || expired) return;
    try {
      let uri = m.localUri;
      if (!uri) {
        if (!file.id) return; // still uploading
        setBusy(true);
        uri = await downloadFile(file);
        await setLocalUri(getDb(), m.id, uri);
        emitDbChange([m.peerId]);
      }
      if (isImage) openImage(uri, { title: file.name ?? undefined });
      else if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: file.mime });
    } catch (e) {
      if (isExpiredError(e)) setExpired(true);
      else Alert.alert("Download failed", "Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (expired) {
    return (
      <View style={styles.fileRow}>
        <Ionicons name="time-outline" size={22} color={colors.muted} />
        <Text style={styles.fileName}>File expired</Text>
      </View>
    );
  }

  if (isImage && m.localUri) {
    return (
      <Pressable onPress={open}>
        <Image source={{ uri: m.localUri }} style={styles.image} contentFit="cover" />
      </Pressable>
    );
  }

  return (
    <Pressable style={styles.fileRow} onPress={open}>
      {busy || (!file.id && m.tick === "pending") ? (
        <ActivityIndicator color={colors.onBubbleAccent} />
      ) : (
        <Ionicons name={isImage ? "image" : file.mime.startsWith("video/") ? "videocam" : "document"} size={26} color={colors.onBubbleAccent} />
      )}
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.fileName} numberOfLines={1}>{file.name ?? "File"}</Text>
        <Text style={[styles.fileSub, m.fromMe === 1 && { color: colors.bubbleMeta }]}>{sizeLabel(file.size)} · {m.localUri ? "tap to open" : "tap to download"}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { maxWidth: "82%", marginVertical: 2 },
  systemWrap: { alignSelf: "center", backgroundColor: colors.elevated, borderRadius: radius.md, paddingHorizontal: space(3), paddingVertical: space(1.5), marginVertical: space(1), maxWidth: "88%" },
  systemText: { fontSize: 12.5, lineHeight: 18, color: colors.muted, textAlign: "center" },
  sender: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  mention: { color: colors.onBubbleAccent, fontWeight: "700" },
  mentionedMe: { },
  left: { alignSelf: "flex-start" },
  right: { alignSelf: "flex-end" },
  bubble: { borderRadius: radius.lg, paddingHorizontal: space(3), paddingTop: space(2), paddingBottom: space(1), gap: 4 },
  mine: { backgroundColor: colors.mine, borderBottomRightRadius: 4 },
  theirs: { backgroundColor: colors.theirs, borderBottomLeftRadius: 4 },
  text: { fontSize: 16, color: colors.text, lineHeight: 22 },
  deleted: { fontSize: 15, fontStyle: "italic", color: colors.muted },
  meta: { flexDirection: "row", alignSelf: "flex-end", alignItems: "center" },
  time: { fontSize: 11, color: colors.muted },
  forwarded: { flexDirection: "row", alignItems: "center", gap: 4 },
  forwardedText: { fontSize: 12, fontStyle: "italic", color: colors.muted },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.onBubbleAccent, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: radius.sm, padding: space(2) },
  quoteName: { fontSize: 12, lineHeight: 17, fontWeight: "700", color: colors.onBubbleAccent },
  quoteText: { fontSize: 13, lineHeight: 18, color: colors.muted },
  reactions: { position: "absolute", bottom: -14, backgroundColor: colors.card, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  fileRow: { flexDirection: "row", alignItems: "center", gap: space(2), paddingVertical: space(1), minWidth: 180 },
  fileName: { fontSize: 15, lineHeight: 20, fontWeight: "600", color: colors.text },
  fileSub: { fontSize: 12, color: colors.muted },
  image: { width: 220, height: 220, borderRadius: radius.md },
});
