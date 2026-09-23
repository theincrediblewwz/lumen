import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { colors } from '@/theme/tokens';

export function CanvasIconButton({ icon, label, onPress }: {
  icon: Parameters<typeof AppIcon>[0]['name'];
  label: string;
  onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={({ pressed }) => [styles.iconButton, { opacity: pressed ? 0.55 : 1 }]}>
    <AppIcon name={icon} size={22} color={colors.ink} />
  </Pressable>;
}

export function CanvasSelectionCard({ title, subtitle, onClose, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return <View style={styles.card}>
    <View style={styles.heading}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={styles.title}>{title}</Text>
        {subtitle ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      <CanvasIconButton icon="close" label="收起节点面板" onPress={onClose} />
    </View>
    {children}
  </View>;
}

export const canvasControlStyles = StyleSheet.create({
  floating: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#EAE8E4',
    boxShadow: '0 3px 14px rgba(32, 32, 31, 0.06)',
  },
});

const styles = StyleSheet.create({
  iconButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  card: { ...canvasControlStyles.floating, padding: 10, gap: 4 },
  heading: { flexDirection: 'row', alignItems: 'center', paddingLeft: 8 },
  title: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  subtitle: { color: colors.inkMuted, fontSize: 12, lineHeight: 18 },
});
