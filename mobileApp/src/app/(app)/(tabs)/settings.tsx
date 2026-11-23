import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, ApiError } from "@/api/client";
import { useAuth } from "@/auth/store";
import { pickSquarePhoto, removeProfilePhoto, setProfilePhoto } from "@/profile/photo";
import { openImage } from "@/ui/openImage";
import { Avatar, Button, Field } from "@/ui/components";
import { colors, radius, space } from "@/ui/theme";

export default function Settings() {
  const me = useAuth((s) => s.me!);
  const [displayName, setDisplayName] = useState(me.displayName ?? "");
  const [about, setAbout] = useState(me.about ?? "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: () => unwrap(api.GET("/blocks")).then((r) => r.users) });

  useEffect(() => {
    setDisplayName(me.displayName ?? "");
    setAbout(me.about ?? "");
  }, [me.displayName, me.about]);

  async function changePhoto() {
    const photo = await pickSquarePhoto();
    if (!photo) return;
    setUploading(true);
    await setProfilePhoto(photo);
    setUploading(false);
  }

  function photoMenu() {
    if (!me.avatarUrl) return void changePhoto();
    Alert.alert("Profile photo", undefined, [
      { text: "View photo", onPress: () => openImage(me.avatarUrl, { cacheKey: me.avatarFileId, title: "Profile photo" }) },
      { text: "Change photo", onPress: () => void changePhoto() },
      { text: "Remove photo", style: "destructive", onPress: () => void removeProfilePhoto().catch(() => Alert.alert("Couldn't remove photo")) },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function saveProfile() {
    setSaving(true);
    try {
      const updated = await unwrap(api.PATCH("/me", { body: { displayName: displayName.trim() || null, about: about.trim() || null } }));
      await useAuth.getState().setMe(updated);
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof ApiError ? e.message : "Try again");
    } finally {
      setSaving(false);
    }
  }

  const dirty = displayName !== (me.displayName ?? "") || about !== (me.about ?? "");

  return (
    <ScrollView contentContainerStyle={{ padding: space(4), gap: space(5) }}>
      <View style={styles.card}>
        <Pressable onPress={photoMenu} style={{ alignItems: "center", gap: space(2) }}>
          <Avatar name={me.displayName || me.username} url={me.avatarUrl} cacheKey={me.avatarFileId} size={96} />
          <Text style={{ color: colors.primary }}>{uploading ? "Uploading…" : me.avatarUrl ? "Edit photo" : "Add photo"}</Text>
        </Pressable>
        <Pressable onPress={() => router.push(`/user/${me.id}`)} style={{ alignItems: "center" }}>
          <Text style={styles.name}>{me.displayName || `@${me.username}`}</Text>
          <Text style={styles.username}>@{me.username}</Text>
          <Text style={styles.muted}>{me.email}</Text>
        </Pressable>
      </View>

      <View style={[styles.card, { alignItems: "stretch", gap: space(3) }]}>
        <Field label="Name" value={displayName} onChangeText={setDisplayName} placeholder="Shown instead of your username" maxLength={50} />
        <Field label="About" value={about} onChangeText={setAbout} placeholder="Hey there! I am using Chat." maxLength={140} hint={`${about.length}/140`} />
        <Button title="Save profile" onPress={saveProfile} loading={saving} disabled={!dirty} />
        <Button title="Change username" variant="ghost" onPress={() => router.push("/edit-username")} />
      </View>

      <View style={[styles.card, { alignItems: "stretch" }]}>
        <Text style={styles.section}>Blocked users</Text>
        {blocks.data?.length ? (
          blocks.data.map((u) => (
            <View key={u.id} style={styles.blockRow}>
              <Pressable onPress={() => router.push(`/user/${u.id}`)}>
                <Avatar name={u.displayName || u.username} url={u.avatarUrl} cacheKey={u.avatarFileId} size={36} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: "600" }}>{u.displayName || `@${u.username}`}</Text>
                {u.displayName ? <Text style={styles.muted}>@{u.username}</Text> : null}
              </View>
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
  name: { fontSize: 20, fontWeight: "700", color: colors.text, marginTop: space(2) },
  username: { fontSize: 15, color: colors.primary },
  muted: { color: colors.muted },
  section: { fontSize: 13, fontWeight: "700", color: colors.muted, textTransform: "uppercase", marginBottom: space(2) },
  blockRow: { flexDirection: "row", alignItems: "center", gap: space(3), paddingVertical: space(2) },
});
