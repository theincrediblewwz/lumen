import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { AppIcon } from '@/components/app-icon';
import { colors, radii } from '@/theme/tokens';

export function QuietDisclosure({ title, meta, children, initiallyOpen = false }: {
  title: string; meta?: string; children: ReactNode; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <View style={{ backgroundColor: colors.surface, borderRadius: radii.medium, overflow: 'hidden' }}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)} style={({ pressed }) => ({ minHeight: 52, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.7 : 1 })}>
      <View style={{ flex: 1, gap: 4 }}><Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600' }}>{title}</Text>{meta ? <Text style={{ color: colors.inkMuted, fontSize: 12 }}>{meta}</Text> : null}</View>
      <AppIcon name={open ? 'expand-less' : 'expand-more'} color={colors.inkMuted} size={20} />
    </Pressable>
    {open ? <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 12 }}>{children}</View> : null}
  </View>;
}
