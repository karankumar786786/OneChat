import { useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useChats } from "../db/hooks";
import { Avatar, Empty, Field } from "./components";
import { colors, space } from "./theme";

/**
 * Pick people for a group. Only people you have chatted with can be added
 * (the server enforces the same rule).
 */
export function MemberPicker({ selected, onToggle, exclude = [], header }: { selected: Set<string>; onToggle: (id: string) => void; exclude?: string[]; header?: ReactNode }) {
  const [chats] = useChats();
  const [q, setQ] = useState("");
  const people = useMemo(() => {
    const skip = new Set(exclude);
    const term = q.trim().toLowerCase().replace(/^@/, "");
    return chats.filter(
      (c) =>
        c.kind === "direct" &&
        c.username &&
        !skip.has(c.peerId) &&
        (!term || c.username.includes(term) || (c.displayName ?? "").toLowerCase().includes(term)),
    );
  }, [chats, q, exclude]);

  return (
    <FlatList
      data={people}
      keyExtractor={(c) => c.peerId}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ padding: space(4), gap: space(3) }}>
          {header}
          <Field value={q} onChangeText={setQ} placeholder="Search people you chat with" autoCapitalize="none" autoCorrect={false} />
        </View>
      }
      ListEmptyComponent={<Empty title="Nobody to add" subtitle="You can add people you have chatted with." />}
      renderItem={({ item }) => {
        const on = selected.has(item.peerId);
        return (
          <Pressable style={styles.row} onPress={() => onToggle(item.peerId)}>
            <Avatar name={item.username} url={item.avatarUrl} cacheKey={item.avatarFileId} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.displayName || `@${item.username}`}</Text>
              {item.displayName ? <Text style={styles.sub}>@{item.username}</Text> : null}
            </View>
            <Ionicons name={on ? "checkmark-circle" : "ellipse-outline"} size={24} color={on ? colors.primary : colors.border} />
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  sub: { fontSize: 13, color: colors.muted },
});
