import { SectionList, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useStatusComments, useStatusViews } from "@/status/queries";
import { Avatar } from "@/ui/components";
import { colors, space } from "@/ui/theme";
import { timeLabel } from "@/lib/format";

export default function StatusActivity() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const views = useStatusViews(id);
  const comments = useStatusComments(id);

  const sections = [
    {
      title: `Viewed by ${views.data?.length ?? 0}`,
      data: (views.data ?? []).map((v) => ({ key: `v-${v.viewer.id}`, user: v.viewer, line: timeLabel(v.viewedAt), extra: v.reaction })),
    },
    {
      title: `Comments (${comments.data?.length ?? 0})`,
      data: (comments.data ?? []).map((c) => ({ key: `c-${c.id}`, user: c.author, line: c.text, extra: timeLabel(c.createdAt) })),
    },
  ];

  return (
    <SectionList
      sections={sections}
      keyExtractor={(i) => i.key}
      renderSectionHeader={({ section }) => <Text style={styles.header}>{section.title}</Text>}
      renderSectionFooter={({ section }) => (section.data.length ? null : <Text style={styles.empty}>Nothing yet</Text>)}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Avatar name={item.user.username} url={item.user.avatarUrl} cacheKey={item.user.avatarFileId} size={40} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{item.user.displayName || `@${item.user.username}`}</Text>
            <Text style={styles.line}>{item.line}</Text>
          </View>
          {item.extra ? <Text style={item.extra.length <= 4 ? { fontSize: 22 } : styles.line}>{item.extra}</Text> : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  header: { fontSize: 13, fontWeight: "700", color: colors.muted, paddingHorizontal: space(4), paddingTop: space(5), paddingBottom: space(2), textTransform: "uppercase", backgroundColor: colors.bg },
  row: { flexDirection: "row", alignItems: "center", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3), backgroundColor: colors.card },
  name: { fontSize: 15, fontWeight: "600", color: colors.text },
  line: { fontSize: 14, color: colors.muted },
  empty: { paddingHorizontal: space(4), color: colors.muted },
});
