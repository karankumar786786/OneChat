import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { useAuth } from "@/auth/store";
import { queryClient } from "@/lib/queryClient";
import { endSession, startSession } from "@/session";
import { colors } from "@/ui/theme";

export default function RootLayout() {
  const status = useAuth((s) => s.status);
  const userId = useAuth((s) => s.me?.id ?? null);
  const hasUsername = useAuth((s) => Boolean(s.me?.username));
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    void useAuth.getState().hydrate();
  }, []);

  // Open the local DB and the socket for the signed-in user; tear down on sign-out.
  useEffect(() => {
    if (status === "signedIn" && userId && hasUsername) {
      let cancelled = false;
      startSession(userId)
        .then(() => !cancelled && setReadyFor(userId))
        .catch((err) => console.error("session start failed", err));
      return () => {
        cancelled = true;
      };
    }
    if (status === "signedOut") {
      setReadyFor(null);
      void endSession();
    }
  }, [status, userId, hasUsername]);

  // Tapping a message notification opens that chat.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const data = r.notification.request.content.data ?? {};
      const chatId = typeof data.groupId === "string" ? data.groupId : data.from;
      if (typeof chatId === "string") router.push(`/chat/${chatId}`);
    });
    return () => sub.remove();
  }, [router]);

  const signedIn = status === "signedIn";
  const inApp = signedIn && hasUsername;
  if (status === "loading" || (inApp && readyFor !== userId)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Screen name="index" />
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
          <Stack.Protected guard={signedIn && !hasUsername}>
            <Stack.Screen name="username" />
          </Stack.Protected>
          <Stack.Protected guard={inApp}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
