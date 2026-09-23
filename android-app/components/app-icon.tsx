import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import type { ComponentProps } from 'react';

type MaterialIconName = ComponentProps<typeof MaterialIcons>['name'];

export function AppIcon({
  name,
  color,
  size = 22,
}: {
  name: MaterialIconName;
  color: string;
  size?: number;
}) {
  return <MaterialIcons name={name} color={color} size={size} />;
}

