import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useNavigation, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useLayoutEffect, useState } from "react";
import { syncConnections } from "@/session";
import { syncGroups } from "@/realtime/socket";
import { useChats } from "@/db/hooks";
import { useRealtime } from "@/realtime/store";
import { Avatar, Empty } from "@/ui/components";
import { colors, space } from "@/ui/theme";
import { timeLabel } from "@/lib/format";

export default function Chats() {
  const [chats] = useChats();
  const presence = useRealtime((s) => s.presence);
  const typing = useRealtime((s) => s.typing);
  const groupTyping = useRealtime((s) => s.groupTyping);
  const connected = useRealtime((s) => s.connected);
  const router = useRouter();
  const navigation = useNavigation();
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    setRefreshing(true);
    await Promise.allSettled([syncConnections(), syncGroups()]);
    setRefreshing(false);
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: connected ? "Chats" : "Connecting…",
      headerRight: () => (
        <View style={{ flexDirection: "row", gap: space(5), marginRight: space(4) }}>
          <Pressable onPress={() => router.push("/group/new")} hitSlop={12}>
            <Ionicons name="people" size={22} color={colors.primary} />
          </Pressable>
          <Pressable onPress={() => router.push("/search")} hitSlop={12}>
            <Ionicons name="search" size={22} color={colors.primary} />
          </Pressable>
        </View>
      ),
    });
  }, [navigation, router, connected]);

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={chats}
        keyExtractor={(c) => c.peerId}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        contentContainerStyle={chats.length ? undefined : { flex: 1 }}
        ListEmptyComponent={<Empty title="No chats yet" subtitle="Tap the search icon to find someone by username, or the people icon to start a group." />}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item }) => {
          const isGroup = item.kind === "group";
          const name = item.displayName || (item.username ? `@${item.username}` : "…");
          const isTyping = isGroup ? Object.keys(groupTyping[item.peerId] ?? {}).length > 0 : Boolean(typing[item.peerId]);
          return (
            <Pressable style={({ pressed }) => [styles.row, pressed && { backgroundColor: "#EEF0F5" }]} onPress={() => router.push(`/chat/${item.peerId}`)}>
              <Pressable onPress={() => router.push(isGroup ? `/group/${item.peerId}` : `/user/${item.peerId}`)} hitSlop={4}>
                <Avatar name={isGroup ? item.displayName : item.username} url={item.avatarUrl} cacheKey={item.avatarFileId} online={!isGroup && presence[item.peerId]?.online} group={isGroup} />
              </Pressable>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.line}>
                  <Text style={styles.name} numberOfLines={1}>{name}</Text>
                  {item.lastAt ? <Text style={[styles.time, item.unread ? { color: colors.primary } : null]}>{timeLabel(item.lastAt)}</Text> : null}
                </View>
                <View style={styles.line}>
                  <Text style={[styles.preview, isTyping && { color: colors.primary }]} numberOfLines={1}>
                    {isTyping ? "typing…" : (item.lastText ?? "Say hi 👋")}
                  </Text>
                  {item.unread ? <Text style={styles.badge}>{item.unread}</Text> : null}
                </View>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 76 },
  line: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space(2) },
  name: { fontSize: 16, fontWeight: "600", color: colors.text, flexShrink: 1 },
  time: { fontSize: 12, color: colors.muted },
  preview: { fontSize: 14, color: colors.muted, flexShrink: 1 },
  badge: { minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: colors.primary, color: "#fff", fontSize: 12, fontWeight: "700", textAlign: "center", lineHeight: 20, overflow: "hidden" },
});
