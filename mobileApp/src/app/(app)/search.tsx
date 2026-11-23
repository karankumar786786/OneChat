import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, type PublicUser } from "@/api/client";
import { getDb } from "@/db";
import { ensureChat } from "@/db/queries";
import { emitDbChange } from "@/db/changes";
import { Avatar, Empty, Field } from "@/ui/components";
import { colors, space } from "@/ui/theme";

/** Find people by name or username. "@abc" searches usernames only. */
export default function Search() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const term = q.trim();
    if (!term || term === "@") {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      const { data } = await api.GET("/users/search", { params: { query: { q: term, limit: 25 } } });
      setResults(data?.users ?? []);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  async function open(u: PublicUser) {
    await ensureChat(getDb(), u.id, u);
    emitDbChange([u.id]);
    router.replace(`/chat/${u.id}`);
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ padding: space(4) }}>
        <Field value={q} onChangeText={setQ} placeholder="Search by name or @username" autoCapitalize="none" autoCorrect={false} autoFocus />
      </View>
      {loading ? <ActivityIndicator color={colors.primary} /> : null}
      <FlatList
        data={results}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={q.trim() && !loading ? <Empty title="Nobody found" subtitle="Try their name, or @ and the start of their username." /> : undefined}
        renderItem={({ item }) => (
          <Pressable style={({ pressed }) => [styles.row, pressed && { backgroundColor: "#EEF0F5" }]} onPress={() => open(item)}>
            <Pressable onPress={() => router.push(`/user/${item.id}`)} hitSlop={4}>
              <Avatar name={item.displayName || item.username} url={item.avatarUrl} cacheKey={item.avatarFileId} />
            </Pressable>
            <View style={{ flex: 1, gap: 1 }}>
              <Text style={styles.name} numberOfLines={1}>{item.displayName || `@${item.username}`}</Text>
              {item.displayName ? <Text style={styles.username}>@{item.username}</Text> : null}
              {item.about ? <Text style={styles.about} numberOfLines={1}>{item.about}</Text> : null}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  username: { fontSize: 14, color: colors.primary },
  about: { fontSize: 13, color: colors.muted },
});
