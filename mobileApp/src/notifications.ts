import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { api } from "./api/client";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Registers this device for push. Needs a physical device and an EAS project id
 * (run `eas init` once); without them it quietly does nothing.
 */
export async function registerForPush() {
  try {
    if (!Device.isDevice) return;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("messages", {
        name: "Messages",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const existing = await Notifications.getPermissionsAsync();
    const status = existing.granted ? existing.status : (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api.PUT("/devices/push-token", { body: { token, platform: Platform.OS === "ios" ? "ios" : "android" } });
  } catch (err) {
    console.warn("push registration skipped", err);
  }
}
