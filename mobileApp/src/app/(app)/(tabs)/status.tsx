import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/auth/store";
import { useMyStatuses, useStatusFeed } from "@/status/queries";
import { Avatar, Empty } from "@/ui/components";
import { colors, space } from "@/ui/theme";
import { timeLabel } from "@/lib/format";

export default function StatusTab() {
  const me = useAuth((s) => s.me);
  const feed = useStatusFeed();
  const mine = useMyStatuses();
  const router = useRouter();
  const myCount = mine.data?.length ?? 0;

  return (
    <FlatList
      data={feed.data ?? []}
      keyExtractor={(e) => e.user.id}
      refreshControl={<RefreshControl tintColor={colors.muted} refreshing={feed.isFetching} onRefresh={() => { void feed.refetch(); void mine.refetch(); }} />}
      ListHeaderComponent={
        <View>
          <Pressable style={styles.row} onPress={() => (myCount ? router.push(`/status/${me!.id}`) : router.push("/status/new"))}>
            <View>
              <Avatar name={me?.username} url={me?.avatarUrl} cacheKey={me?.avatarFileId} ring={myCount ? "seen" : undefined} />
              <View style={styles.plus}>
                <Ionicons name="add" size={14} color="#fff" />
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>My status</Text>
              <Text style={styles.sub}>{myCount ? `${myCount} update${myCount > 1 ? "s" : ""} · disappears after 24h` : "Tap to add a status"}</Text>
            </View>
            <Pressable hitSlop={10} onPress={() => router.push("/status/new")}>
              <Ionicons name="create-outline" size={22} color={colors.accent} />
            </Pressable>
          </Pressable>
          <Text style={styles.section}>Recent updates</Text>
        </View>
      }
      ListEmptyComponent={!feed.isLoading ? <Empty title="No updates" subtitle="Statuses from people you chat with show up here." /> : undefined}
      renderItem={({ item }) => (
        <Pressable style={styles.row} onPress={() => router.push(`/status/${item.user.id}`)}>
          <Avatar name={item.user.username} url={item.user.avatarUrl} cacheKey={item.user.avatarFileId} ring={item.hasUnviewed ? "unseen" : "seen"} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{item.user.displayName || `@${item.user.username}`}</Text>
            <Text style={styles.sub}>{timeLabel(item.latestAt)}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card },
  name: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.text },
  sub: { fontSize: 13, color: colors.muted },
  section: { fontSize: 13, fontWeight: "700", color: colors.muted, paddingHorizontal: space(4), paddingTop: space(5), paddingBottom: space(2), textTransform: "uppercase" },
  plus: { position: "absolute", right: 0, bottom: 0, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.card },
});
