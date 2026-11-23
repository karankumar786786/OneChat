import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, unwrap, ApiError, type Me } from "../api/client";
import { uploadFile, type PickedFile } from "../files/upload";
import { useAuth } from "../auth/store";

/** Square crop from the photo library, as WhatsApp does for profile photos. */
export async function pickSquarePhoto(): Promise<PickedFile | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
  const a = r.assets?.[0];
  if (r.canceled || !a) return null;
  return { uri: a.uri, name: a.fileName ?? "photo.jpg", mime: a.mimeType ?? "image/jpeg", size: a.fileSize ?? 0 };
}

/** Explains upload failures in plain words (the common one in dev: S3 not configured yet). */
export function uploadErrorMessage(e: unknown) {
  if (e instanceof ApiError && e.code === "STORAGE_NOT_CONFIGURED") return "Photo uploads aren't set up on the server yet (S3 bucket missing).";
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message.startsWith("No answer")) return `${e.message}. Is the engine running and reachable from this device?`;
  return "Upload failed. Check your connection and that the S3 bucket and keys are set on the server.";
}

/** Uploads a profile photo to S3 and makes it your DP. */
export async function setProfilePhoto(photo: PickedFile): Promise<Me | null> {
  try {
    const file = await uploadFile(photo, "avatar");
    const me = await unwrap(api.PATCH("/me", { body: { avatarFileId: file.id } }));
    await useAuth.getState().setMe(me);
    return me;
  } catch (e) {
    Alert.alert("Couldn't update photo", uploadErrorMessage(e));
    return null;
  }
}

export async function removeProfilePhoto() {
  const me = await unwrap(api.PATCH("/me", { body: { avatarFileId: null } }));
  await useAuth.getState().setMe(me);
}
