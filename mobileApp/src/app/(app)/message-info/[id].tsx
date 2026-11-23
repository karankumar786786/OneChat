import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { getDb } from "@/db";
import { onDbChange } from "@/db/changes";
import { getGroup, membersOf } from "@/db/groups";
import { getMessage } from "@/db/queries";
import { Avatar, Ticks } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";
import { timeLabel } from "@/lib/format";
import type { GroupMemberRow, MessageRow } from "@/db/types";

interface Line {
  member: GroupMemberRow | { id: string; username: string; displayName: null; avatarUrl: null; avatarFileId: null };
  deliveredAt: string | null;
  readAt: string | null;
}

/** For your group message: who has received it and who has read it, and when. */
export default function MessageInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [message, setMessage] = useState<MessageRow | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  const load = useCallback(async () => {
    const db = getDb();
    const m = await getMessage(db, id);
    setMessage(m);
    if (!m) return;
    const members = new Map(membersOf(await getGroup(db, m.peerId)).map((x) => [x.id, x]));
    const recipients = m.recipientsJson ? (JSON.parse(m.recipientsJson) as string[]) : [];
    const receipts = new Map(
      (await db.all<{ userId: string; deliveredAt: string | null; readAt: string | null }>("SELECT * FROM receipts WHERE messageId = ?", [id])).map((r) => [r.userId, r]),
    );
    setLines(
      recipients.map((uid) => ({
        member: members.get(uid) ?? { id: uid, username: "former member", displayName: null, avatarUrl: null, avatarFileId: null },
        deliveredAt: receipts.get(uid)?.deliveredAt ?? null,
        readAt: receipts.get(uid)?.readAt ?? null,
      })),
    );
  }, [id]);

  useEffect(() => {
    void load();
    return onDbChange(() => void load());
  }, [load]);

  const read = lines.filter((l) => l.readAt);
  const delivered = lines.filter((l) => l.deliveredAt && !l.readAt);
  const pending = lines.filter((l) => !l.deliveredAt);

  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(4) }}>
      {message ? (
        <View style={styles.bubble}>
          <Text style={{ color: colors.text, fontSize: 16 }}>{message.text ?? "📎 File"}</Text>
          <View style={{ flexDirection: "row", alignSelf: "flex-end", alignItems: "center" }}>
            <Text style={styles.muted}>{timeLabel(message.sentAt)}</Text>
            <Ticks tick={message.tick} />
          </View>
        </View>
      ) : null}
      <Section title={`Read by ${read.length}`} icon="read" lines={read} time={(l) => l.readAt} />
      <Section title={`Delivered to ${delivered.length}`} icon="delivered" lines={delivered} time={(l) => l.deliveredAt} />
      {pending.length ? <Section title={`Not delivered yet (${pending.length})`} icon="sent" lines={pending} time={() => null} /> : null}
    </ScrollView>
  );
}

function Section({ title, icon, lines, time }: { title: string; icon: "read" | "delivered" | "sent"; lines: Line[]; time: (l: Line) => string | null }) {
  return (
    <View style={styles.card}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
        <Ticks tick={icon} />
        <Text style={styles.section}>{title}</Text>
      </View>
      {lines.length === 0 ? <Text style={styles.muted}>Nobody yet</Text> : null}
      {lines.map((l) => (
        <View key={l.member.id} style={styles.row}>
          <Avatar name={l.member.username} url={l.member.avatarUrl} cacheKey={l.member.avatarFileId} size={36} />
          <Text style={{ flex: 1, color: colors.text, fontSize: 15 }}>{l.member.displayName || `@${l.member.username}`}</Text>
          {time(l) ? <Text style={styles.muted}>{timeLabel(time(l)!)}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: { alignSelf: "flex-end", maxWidth: "85%", backgroundColor: colors.mine, borderRadius: radius.lg, padding: space(3), gap: 4 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space(4), gap: space(3) },
  section: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase" },
  row: { flexDirection: "row", alignItems: "center", gap: space(3) },
  muted: { color: colors.muted, fontSize: 13 },
});
