import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "react-native";
import { UsernameForm } from "@/ui/UsernameForm";
import { authStyles as styles } from "@/ui/authStyles";
import { Button } from "@/ui/components";
import { useAuth } from "@/auth/store";
import { View } from "react-native";

export default function PickUsername() {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.wrap}>
        <Text style={styles.title}>Pick a username</Text>
        <Text style={styles.subtitle}>People find you by it. You can change it later.</Text>
        <UsernameForm />
        <Button title="Sign out" variant="ghost" onPress={() => void useAuth.getState().signOut()} />
      </View>
    </SafeAreaView>
  );
}
