import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { getDb } from "@/db";
import { deleteChatHistory, ensureChat } from "@/db/queries";
import { emitDbChange } from "@/db/changes";
import { useRealtime } from "@/realtime/store";
import { Avatar, Empty } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";
import { lastSeenLabel } from "@/lib/format";
import { openImage } from "@/ui/openImage";

/** WhatsApp-style contact info: photo, name, @username, About, last seen, groups in common, block. */
export default function UserProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const live = useRealtime((s) => s.presence[id]);
  const profile = useQuery({ queryKey: ["profile", id], queryFn: () => unwrap(api.GET("/users/{id}/profile", { params: { path: { id } } })) });

  if (profile.isLoading) return <Empty title="Loading…" />;
  if (!profile.data) return <Empty title="Profile not available" subtitle="This user may not exist, or isn't visible to you." />;
  const { user, isMe, blockedByMe, commonGroups } = profile.data;
  const name = user.displayName || `@${user.username}`;
  // Live presence from the socket wins over the snapshot from the API.
  const online = live?.online ?? profile.data.online;
  const lastSeen = live?.lastSeenAt ?? profile.data.lastSeenAt;
  const status = blockedByMe ? "Blocked" : online === null ? null : lastSeenLabel(Boolean(online), lastSeen);

  async function openChat() {
    await ensureChat(getDb(), user.id, user);
    emitDbChange([user.id]);
    router.push(`/chat/${user.id}`);
  }

  async function toggleBlock() {
    const path = { params: { path: { userId: user.id } } };
    if (blockedByMe) await api.DELETE("/blocks/{userId}", path);
    else await api.POST("/blocks/{userId}", path);
    await qc.invalidateQueries({ queryKey: ["profile", id] });
    void qc.invalidateQueries({ queryKey: ["blocks"] });
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: space(12) }}>
      <View style={styles.hero}>
        <Pressable disabled={!user.avatarUrl} onPress={() => openImage(user.avatarUrl, { cacheKey: user.avatarFileId, title: name })}>
          <Avatar name={user.username} url={user.avatarUrl} cacheKey={user.avatarFileId} size={140} />
        </Pressable>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.username}>@{user.username}</Text>
        {status ? <Text style={[styles.status, online && !blockedByMe ? { color: colors.accent } : null]}>{status}</Text> : null}

        <View style={styles.actions}>
          {isMe ? (
            <Action icon="create-outline" label="Edit" onPress={() => router.push("/settings")} />
          ) : (
            <Action icon="chatbubble" label="Message" onPress={openChat} />
          )}
          <Action icon="share-outline" label="Share" onPress={() => void Share.share({ message: `Chat with ${name} — username @${user.username}` })} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>About</Text>
        <Text style={styles.about}>{user.about || "Hey there! I am using Chat."}</Text>
      </View>

      {!isMe ? (
        <View style={[styles.card, { paddingHorizontal: 0 }]}>
          <Text style={[styles.label, { paddingHorizontal: space(4) }]}>
            {commonGroups.length ? `${commonGroups.length} group${commonGroups.length > 1 ? "s" : ""} in common` : "No groups in common"}
          </Text>
          {commonGroups.map((g) => (
            <Pressable key={g.id} style={styles.row} onPress={() => router.push(`/chat/${g.id}`)}>
              <Avatar name={g.name} url={g.avatarUrl} cacheKey={g.avatarFileId} size={40} group />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{g.name}</Text>
                <Text style={styles.muted}>{g.memberCount} participants</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}

      {!isMe ? (
        <View style={styles.card}>
          <Pressable
            style={styles.dangerRow}
            onPress={() =>
              Alert.alert(blockedByMe ? `Unblock ${name}?` : `Block ${name}?`, blockedByMe ? undefined : "They won't be able to message you, find you, or see your status and last seen.", [
                { text: "Cancel", style: "cancel" },
                { text: blockedByMe ? "Unblock" : "Block", style: blockedByMe ? "default" : "destructive", onPress: () => void toggleBlock() },
              ])
            }
          >
            <Ionicons name="ban" size={20} color={colors.danger} />
            <Text style={styles.danger}>{blockedByMe ? `Unblock ${name}` : `Block ${name}`}</Text>
          </Pressable>
          <Pressable
            style={styles.dangerRow}
            onPress={() =>
              Alert.alert("Clear this chat?", "Messages are deleted from this phone only.", [
                { text: "Cancel", style: "cancel" },
                { text: "Clear chat", style: "destructive", onPress: () => void deleteChatHistory(getDb(), user.id).then(() => emitDbChange([user.id])) },
              ])
            }
          >
            <Ionicons name="trash-outline" size={20} color={colors.danger} />
            <Text style={styles.danger}>Clear chat</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

function Action({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
      <Ionicons name={icon} size={22} color={colors.accent} />
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", backgroundColor: colors.card, paddingVertical: space(6), gap: space(1) },
  name: { fontSize: 24, lineHeight: 32, fontWeight: "700", color: colors.text, marginTop: space(3) },
  username: { fontSize: 15, color: colors.muted },
  status: { fontSize: 13, color: colors.muted, marginTop: space(1) },
  actions: { flexDirection: "row", gap: space(3), marginTop: space(4) },
  action: { width: 92, alignItems: "center", gap: space(1), paddingVertical: space(3), borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  actionLabel: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  card: { backgroundColor: colors.card, marginTop: space(3), padding: space(4), gap: space(2) },
  label: { fontSize: 13, color: colors.muted },
  about: { fontSize: 16, lineHeight: 22, color: colors.text },
  row: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(2) },
  rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  dangerRow: { flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(2) },
  danger: { color: colors.danger, fontSize: 16 },
});
