import { useLayoutEffect, useMemo, useState } from "react";
import { Alert, Pressable, Text } from "react-native";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { api, unwrap, ApiError } from "@/api/client";
import { getDb } from "@/db";
import { membersOf, saveGroup } from "@/db/groups";
import { emitDbChange } from "@/db/changes";
import { useGroup } from "@/db/hooks";
import { MemberPicker } from "@/ui/MemberPicker";
import { colors } from "@/ui/theme";

export default function AddParticipants() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [group] = useGroup(id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const navigation = useNavigation();
  const router = useRouter();
  const existing = useMemo(() => membersOf(group).map((m) => m.id), [group]);

  async function add() {
    setBusy(true);
    try {
      const updated = await unwrap(api.POST("/groups/{id}/members", { params: { path: { id } }, body: { userIds: [...selected] } }));
      await saveGroup(getDb(), updated);
      emitDbChange([id]);
      router.back();
    } catch (e) {
      Alert.alert("Could not add", e instanceof ApiError ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable disabled={!selected.size || busy} onPress={add} hitSlop={10}>
          <Text style={{ color: selected.size ? colors.primary : colors.muted, fontWeight: "700", fontSize: 16 }}>
            Add{selected.size ? ` (${selected.size})` : ""}
          </Text>
        </Pressable>
      ),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation, selected, busy]);

  return (
    <MemberPicker
      selected={selected}
      exclude={existing}
      onToggle={(uid) => {
        const next = new Set(selected);
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
        setSelected(next);
      }}
    />
  );
}
