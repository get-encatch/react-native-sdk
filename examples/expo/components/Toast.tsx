import { StyleSheet, Text, View } from 'react-native';

interface ToastProps {
  message: string | null;
}

export function Toast({ message }: ToastProps) {
  if (!message) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 80,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignSelf: 'center',
  },
  text: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
  },
});
