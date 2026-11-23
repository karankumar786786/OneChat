import { useState } from "react";
import { KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { Link } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, unwrap, ApiError } from "@/api/client";
import { useAuth } from "@/auth/store";
import { Button, Field } from "@/ui/components";
import { space } from "@/ui/theme";
import { authStyles as styles } from "@/ui/authStyles";

export default function Login() {
  const reason = useAuth((s) => s.signedOutReason);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const res = await unwrap(api.POST("/auth/login", { body: { email, password } }));
      await useAuth.getState().setSession(res.user, res.tokens);
    } catch (e) {
      console.warn("login failed", e);
      setError(e instanceof ApiError ? e.message : "Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in with your email and password.</Text>
        {reason ? <Text style={styles.notice}>{reason}</Text> : null}
        <View style={{ gap: space(3) }}>
          <Field label="Email" value={email} onChangeText={(t) => { setEmail(t); setError(null); }} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
          <Field label="Password" value={password} onChangeText={(t) => { setPassword(t); setError(null); }} secureTextEntry autoComplete="password" textContentType="password" error={error} onSubmitEditing={submit} />
          <Button title="Sign in" onPress={submit} loading={busy} disabled={!email || !password} />
        </View>
        <Link href="/register" style={styles.link}>
          New here? Create an account
        </Link>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
