import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/api/client";
import { useAuth } from "@/auth/store";
import { uploadFile } from "@/files/upload";
import { Avatar, Button, Field } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";

export default function Settings() {
  const me = useAuth((s) => s.me!);
  const [displayName, setDisplayName] = useState(me.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: () => unwrap(api.GET("/blocks")).then((r) => r.users) });

  async function changeAvatar() {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    const a = r.assets?.[0];
    if (r.canceled || !a) return;
    try {
      const file = await uploadFile({ uri: a.uri, name: a.fileName ?? "avatar.jpg", mime: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 }, "avatar");
      await useAuth.getState().setMe(await unwrap(api.PATCH("/me", { body: { avatarFileId: file.id } })));
    } catch (e) {
      Alert.alert("Could not update photo", e instanceof Error ? e.message : "Try again");
    }
  }

  async function saveName() {
    setSaving(true);
    try {
      await useAuth.getState().setMe(await unwrap(api.PATCH("/me", { body: { displayName: displayName.trim() || null } })));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(5) }}>
      <View style={styles.card}>
        <Pressable onPress={changeAvatar} style={{ alignItems: "center", gap: space(2) }}>
          <Avatar name={me.username} url={me.avatarUrl} cacheKey={me.avatarFileId} size={84} />
          <Text style={{ color: colors.primary }}>Change photo</Text>
        </Pressable>
        <Text style={styles.username}>@{me.username}</Text>
        <Text style={styles.muted}>{me.email}</Text>
      </View>

      <View style={[styles.card, { alignItems: "stretch", gap: space(3) }]}>
        <Field label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="Shown instead of your username" maxLength={50} />
        <Button title="Save name" onPress={saveName} loading={saving} disabled={displayName === (me.displayName ?? "")} />
        <Button title="Change username" variant="ghost" onPress={() => router.push("/edit-username")} />
      </View>

      <View style={[styles.card, { alignItems: "stretch" }]}>
        <Text style={styles.section}>Blocked users</Text>
        {blocks.data?.length ? (
          blocks.data.map((u) => (
            <View key={u.id} style={styles.blockRow}>
              <Avatar name={u.username} url={u.avatarUrl} cacheKey={u.avatarFileId} size={36} />
              <Text style={{ flex: 1, color: colors.text }}>@{u.username}</Text>
              <Pressable
                onPress={async () => {
                  await api.DELETE("/blocks/{userId}", { params: { path: { userId: u.id } } });
                  void qc.invalidateQueries({ queryKey: ["blocks"] });
                }}
              >
                <Text style={{ color: colors.primary, fontWeight: "600" }}>Unblock</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.muted}>Nobody</Text>
        )}
      </View>

      <Button
        title="Sign out"
        variant="danger"
        onPress={() =>
          Alert.alert("Sign out?", "Chat history lives only on this phone and stays here for when you sign back in.", [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: () => void useAuth.getState().signOut() },
          ])
        }
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: space(4), alignItems: "center", gap: space(1) },
  username: { fontSize: 20, fontWeight: "700", color: colors.text, marginTop: space(2) },
  muted: { color: colors.muted },
  section: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", marginBottom: space(2) },
  blockRow: { flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(2) },
});
