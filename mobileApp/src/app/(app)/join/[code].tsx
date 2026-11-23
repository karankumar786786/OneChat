import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, unwrap, ApiError, type Schemas } from "@/api/client";
import { getDb } from "@/db";
import { saveGroup } from "@/db/groups";
import { emitDbChange } from "@/db/changes";
import { Avatar, Button, Empty } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";

/** Opened from an invite link (chat://join/<code>) or a pasted code. */
export default function JoinGroup() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const [preview, setPreview] = useState<Schemas["GroupInvitePreview"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  useEffect(() => {
    unwrap(api.GET("/groups/invite/{code}", { params: { path: { code } } }))
      .then(setPreview)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load this invite"));
  }, [code]);

  async function join() {
    setBusy(true);
    try {
      const group = await unwrap(api.POST("/groups/invite/{code}/join", { params: { path: { code } } }));
      await saveGroup(getDb(), group);
      emitDbChange([group.id]);
      router.replace(`/chat/${group.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not join");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Empty title="Can't open this invite" subtitle={error} />;
  if (!preview) return <Empty title="Loading invite…" />;

  return (
    <View style={styles.wrap}>
      <View style={styles.card}>
        <Avatar name={preview.name} url={preview.avatarUrl} cacheKey={preview.avatarFileId} size={96} group />
        <Text style={styles.title}>{preview.name}</Text>
        <Text style={styles.muted}>Group · {preview.memberCount} participants</Text>
        {preview.description ? <Text style={{ color: colors.text, textAlign: "center" }}>{preview.description}</Text> : null}
      </View>
      {preview.alreadyMember ? (
        <Button title="Open group" onPress={() => router.replace(`/chat/${preview.groupId}`)} />
      ) : (
        <Button title="Join group" onPress={join} loading={busy} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, padding: space(6), justifyContent: "center", gap: space(6) },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space(6), alignItems: "center", gap: space(2) },
  title: { fontSize: 22, fontWeight: "700", color: colors.text, marginTop: space(2) },
  muted: { color: colors.muted },
});
