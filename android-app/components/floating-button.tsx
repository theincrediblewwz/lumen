import { ActivityIndicator, Pressable, Text } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { colors, floatingShadow, radii } from '@/theme/tokens';

type Props = {
  label?: string;
  accessibilityLabel?: string;
  icon: Parameters<typeof AppIcon>[0]['name'];
  onPress: () => void;
  tone?: 'dark' | 'light';
  disabled?: boolean;
  loading?: boolean;
};

export function FloatingButton({ label, accessibilityLabel, icon, onPress, tone = 'light', disabled = false, loading = false }: Props) {
  const dark = tone === 'dark';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        paddingHorizontal: label ? 20 : 15,
        borderRadius: radii.floating,
        borderCurve: 'continuous',
        backgroundColor: dark ? colors.ink : colors.surfaceStrong,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 9,
        boxShadow: floatingShadow,
        opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      {loading
        ? <ActivityIndicator color={dark ? colors.white : colors.ink} size="small" />
        : <AppIcon name={icon} color={dark ? colors.white : colors.ink} size={21} />}
      {label ? (
        <Text style={{ color: dark ? colors.white : colors.ink, fontSize: 15, fontWeight: '700' }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

