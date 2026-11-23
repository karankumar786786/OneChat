import { useEffect, useState } from "react";
import { View } from "react-native";
import { api, unwrap, ApiError } from "../api/client";
import { useAuth } from "../auth/store";
import { Button, Field } from "./components";
import { space } from "./theme";

/** Username input with a live availability check. Used at sign-up and in settings. */
export function UsernameForm({ onDone }: { onDone?: () => void }) {
  const current = useAuth((s) => s.me?.username ?? "");
  const [value, setValue] = useState(current);
  const [check, setCheck] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = value.trim();
    setCheck(null);
    if (q.length < 3 || q.toLowerCase() === current) return;
    const t = setTimeout(async () => {
      const { data } = await api.GET("/users/username-available", { params: { query: { u: q } } });
      if (data) setCheck({ available: data.available, reason: data.reason });
    }, 350);
    return () => clearTimeout(t);
  }, [value, current]);

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const me = await unwrap(api.PUT("/me/username", { body: { username: value.trim() } }));
      await useAuth.getState().setMe(me);
      onDone?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const hint = check ? (check.available ? "✓ Available" : check.reason) : "3–20 characters: letters, numbers, _ and .";
  return (
    <View style={{ gap: space(3) }}>
      <Field
        label="Username"
        value={value}
        onChangeText={(t) => setValue(t.replace(/\s/g, "").toLowerCase())}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="e.g. karan_s"
        error={error ?? (check && !check.available ? check.reason : null)}
        hint={hint}
        onSubmitEditing={save}
      />
      <Button title="Save username" onPress={save} loading={busy} disabled={value.trim().length < 3 || check?.available === false || value === current} />
    </View>
  );
}
