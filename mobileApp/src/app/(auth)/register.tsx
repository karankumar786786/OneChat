import { useState } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { Link } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, unwrap, ApiError } from "@/api/client";
import { useAuth } from "@/auth/store";
import { Button, Field } from "@/ui/components";
import { space } from "@/ui/theme";
import { authStyles as styles } from "@/ui/authStyles";

export default function Register() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;

  const tooShort = password.length > 0 && password.length < 8;

  async function submit() {
    if (password.length < 8 || mismatch) return;
    setError(null);
    setBusy(true);
    try {
      const res = await unwrap(api.POST("/auth/register", { body: { email, password } }));
      await useAuth.getState().setSession(res.user, res.tokens);
    } catch (e) {
      console.warn("register failed", e);
      setError(e instanceof ApiError ? e.message : "Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
        <Text style={styles.title}>Create account</Text>
        <Text style={styles.subtitle}>You will pick a username next.</Text>
        <View style={{ gap: space(3) }}>
          <Field label="Email" value={email} onChangeText={(t) => { setEmail(t); setError(null); }} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" error={error} />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" hint="At least 8 characters" error={tooShort ? "Use at least 8 characters" : null} />
          <Field label="Confirm password" value={confirm} onChangeText={setConfirm} secureTextEntry error={mismatch ? "Passwords do not match" : null} onSubmitEditing={submit} />
          <Button title="Create account" onPress={submit} loading={busy} disabled={!email || password.length < 8 || !confirm || mismatch} />
        </View>
        <Link href="/login" style={styles.link}>
          Already have an account? Sign in
        </Link>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
