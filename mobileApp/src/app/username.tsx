import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, unwrap, ApiError } from "@/api/client";
import { useAuth } from "@/auth/store";
import { pickSquarePhoto, setProfilePhoto } from "@/profile/photo";
import type { PickedFile } from "@/files/upload";
import { useUsernameCheck, usernameHint } from "@/ui/UsernameForm";
import { authStyles as styles } from "@/ui/authStyles";
import { Avatar, Button, Field } from "@/ui/components";
import { colors, space } from "@/ui/theme";

/** After sign-up: photo (optional), your name, and a unique username. */
export default function ProfileSetup() {
  const me = useAuth((s) => s.me);
  const [photo, setPhoto] = useState<PickedFile | null>(null);
  const [name, setName] = useState(me?.displayName ?? "");
  const [username, setUsername] = useState("");
  const check = useUsernameCheck(username, "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      // Name and photo first: setting the username is what moves you into the app.
      await unwrap(api.PATCH("/me", { body: { displayName: name.trim() } }));
      if (photo) await setProfilePhoto(photo);
      const updated = await unwrap(api.PUT("/me/username", { body: { username: username.trim() } }));
      await useAuth.getState().setMe(updated);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={[styles.wrap, { flexGrow: 1 }]} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Your profile</Text>
          <Text style={styles.subtitle}>Add your name and an optional photo. People find you by your username.</Text>
          <Pressable onPress={async () => setPhoto((await pickSquarePhoto()) ?? photo)} style={{ alignItems: "center", gap: space(2) }}>
            <Avatar name={name || username || "?"} url={photo?.uri} size={96} />
            <Text style={{ color: colors.accent }}>{photo ? "Change photo" : "Add photo"}</Text>
          </Pressable>
          <View style={{ gap: space(3) }}>
            <Field label="Your name" value={name} onChangeText={setName} placeholder="e.g. Karan Sharma" maxLength={50} autoComplete="name" textContentType="name" />
            <Field
              label="Username"
              value={username}
              onChangeText={(t) => setUsername(t.replace(/\s/g, "").replace(/^@/, "").toLowerCase())}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="e.g. karan_s"
              error={error ?? (check && !check.available ? check.reason : null)}
              hint={usernameHint(check)}
              onSubmitEditing={save}
            />
            <Button title="Continue" onPress={save} loading={busy} disabled={!name.trim() || username.trim().length < 3 || check?.available === false} />
          </View>
          <Button title="Sign out" variant="ghost" onPress={() => void useAuth.getState().signOut()} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
