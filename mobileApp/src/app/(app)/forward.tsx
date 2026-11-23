import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useChats } from "@/db/hooks";
import { forwardMessage } from "@/chat/actions";
import { Avatar, Empty } from "@/ui/components";
import { colors, space } from "@/ui/theme";

export default function Forward() {
  const { messageId } = useLocalSearchParams<{ messageId: string }>();
  const [chats] = useChats();
  const router = useRouter();

  return (
    <FlatList
      data={chats}
      keyExtractor={(c) => c.peerId}
      ListEmptyComponent={<Empty title="No chats to forward to" />}
      renderItem={({ item }) => (
        <Pressable
          style={styles.row}
          onPress={async () => {
            await forwardMessage(messageId, item.peerId);
            router.back();
            router.push(`/chat/${item.peerId}`);
          }}
        >
          <Avatar name={item.kind === "group" ? item.displayName : item.username} url={item.avatarUrl} cacheKey={item.avatarFileId} size={40} group={item.kind === "group"} />
          <View>
            <Text style={styles.name}>{item.displayName || `@${item.username ?? "…"}`}</Text>
            {item.kind === "group" ? <Text style={styles.sub}>Group</Text> : item.displayName ? <Text style={styles.sub}>@{item.username}</Text> : null}
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space(3), padding: space(3), paddingHorizontal: space(4), backgroundColor: colors.card, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: 16, fontWeight: "600", color: colors.text },
  sub: { fontSize: 13, color: colors.muted },
});
