import { useState } from 'react';
import { TextInput, type TextInputProps } from 'react-native';
import { colors, radii } from '@/theme/tokens';

type Props = Pick<TextInputProps, 'accessibilityLabel' | 'editable' | 'placeholder' | 'value' | 'onChangeText'> & {
  minHeight?: number;
  maxHeight?: number;
};

export function AutoGrowingInput({ minHeight = 92, maxHeight = 220, value, onChangeText, ...props }: Props) {
  const [contentHeight, setContentHeight] = useState(minHeight);
  const height = Math.max(minHeight, Math.min(maxHeight, contentHeight + 28));
  return <TextInput
    {...props}
    value={value}
    onChangeText={text => {
      if (!text) setContentHeight(minHeight);
      onChangeText?.(text);
    }}
    multiline
    textAlignVertical="top"
    onContentSizeChange={event => setContentHeight(event.nativeEvent.contentSize.height)}
    placeholderTextColor={colors.gray}
    style={{ height, minHeight, maxHeight, width: '100%', color: colors.ink, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.line, borderRadius: radii.medium, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, lineHeight: 24 }}
  />;
}
