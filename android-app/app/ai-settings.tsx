import { useCallback, useState } from 'react';
import { router, Stack, useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { clearByokDataConsent } from '@/ai/byok-data-consent';
import { testByokConnection } from '@/ai/byok-client';
import {
  clearByokProfile,
  DEEPSEEK_BYOK_PRESET,
  getByokCredentials,
  getByokProfileStatus,
  normalizeByokProfile,
  MIMO_BYOK_PRESET,
  saveByokProfile,
  type ByokProfile,
} from '@/ai/byok-profile';
import { AppIcon } from '@/components/app-icon';
import { colors, floatingShadow, radii } from '@/theme/tokens';

const EMPTY_CUSTOM_PROFILE: ByokProfile = {
  kind: 'custom',
  label: '自定义服务',
  baseUrl: '',
  model: '',
  jsonMode: true,
  tokenLimitField: 'max_tokens',
};

export default function AiSettingsScreen() {
  const [profile, setProfile] = useState<ByokProfile>({ ...DEEPSEEK_BYOK_PRESET });
  const [apiKey, setApiKey] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | 'consent' | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const status = await getByokProfileStatus();
    if (status.profile) setProfile(status.profile);
    setHasSavedKey(status.hasApiKey);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    load().catch(() => {
      setMessage('无法读取安全存储');
      setLoading(false);
    });
  }, [load]));

  const selectKind = (kind: ByokProfile['kind']) => {
    setMessage('');
    if (kind === 'deepseek') {
      setProfile({ ...DEEPSEEK_BYOK_PRESET });
    } else if (kind === 'mimo') {
      setProfile({ ...MIMO_BYOK_PRESET });
    } else if (profile.kind !== 'custom') {
      setProfile({ ...EMPTY_CUSTOM_PROFILE });
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy('save');
    setMessage('');
    try {
      const saved = await saveByokProfile(profile, apiKey || undefined);
      setProfile(saved);
      setApiKey('');
      setHasSavedKey(true);
      await clearByokDataConsent();
      setMessage('已安全保存。下次展开前会确认发送目标。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(null);
    }
  };

  const confirmTest = () => {
    if (busy) return;
    Alert.alert(
      '测试真实连接？',
      '这会向当前服务发送一条极短消息，可能产生少量 token 费用。失败后不会自动重试。',
      [
        { text: '取消', style: 'cancel' },
        { text: '开始测试', onPress: runTest },
      ],
    );
  };

  const runTest = async () => {
    setBusy('test');
    setMessage('');
    try {
      const stored = await getByokCredentials();
      const pending = normalizeByokProfile(profile);
      const key = apiKey.trim() || (stored?.profile.baseUrl === pending.baseUrl ? stored.apiKey : '');
      const result = await testByokConnection(profile, key);
      const usage = result.usage ? ` · ${result.usage.totalTokens} tokens` : '';
      setMessage(`连接成功${result.actualModel ? ` · ${result.actualModel}` : ''}${usage}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '连接测试失败');
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = () => {
    if (busy || (!hasSavedKey && !apiKey)) return;
    Alert.alert('删除本机 AI 配置？', 'API key 和发送确认会从本机安全存储中删除。项目和 Markdown 不受影响。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setBusy('delete');
          try {
            await Promise.all([clearByokProfile(), clearByokDataConsent()]);
            setApiKey('');
            setHasSavedKey(false);
            setProfile({ ...DEEPSEEK_BYOK_PRESET });
            setMessage('本机 AI 配置已删除。');
          } catch (error) {
            setMessage(error instanceof Error ? error.message : '删除失败');
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  };

  const resetSendConsent = async () => {
    if (busy) return;
    setBusy('consent');
    setMessage('');
    try {
      await clearByokDataConsent();
      setMessage('已设置：下次向个人 AI 发送前会重新询问。已经发送的内容无法收回。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法更新发送设置');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas }}><ActivityIndicator color={colors.ink} /></View>;
  }

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 18, paddingBottom: 48, gap: 18 }}
    >
      <Stack.Screen options={{ title: 'AI 设置' }} />

      <View style={{ gap: 7 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 24, lineHeight: 31, fontWeight: '800' }}>使用你自己的 AI 服务</Text>
        <Text selectable style={{ color: colors.inkMuted, fontSize: 14, lineHeight: 21 }}>
          APK 不包含 API key。保存后，key 只留在这台手机的安全存储中。
        </Text>
      </View>

      <View style={{ padding: 15, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: hasSavedKey ? colors.greenSoft : colors.amberSoft, gap: 5 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 13, fontWeight: '800' }}>
          {hasSavedKey ? `已连接配置 · ${profile.label}` : '未连接 AI'}
        </Text>
        <Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
          {hasSavedKey
            ? `展开时将使用已安全保存的 key，目标模型为 ${profile.model}。项目页会再次显示实际连接状态。`
            : '保存服务地址、模型和 API key 后，项目页才会把问题发送给远程 AI；否则只可显式运行本地演示。'}
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/prompt-templates')}
        style={({ pressed }) => ({
          minHeight: 58,
          paddingHorizontal: 16,
          borderRadius: radii.medium,
          borderCurve: 'continuous',
          backgroundColor: colors.surfaceStrong,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          opacity: pressed ? 0.76 : 1,
        })}
      >
        <AppIcon name="bookmarks" color={colors.blue} size={21} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '800' }}>管理询问模板</Text>
          <Text style={{ color: colors.inkMuted, fontSize: 11.5 }}>保存、编辑和删除节点下方的快捷追问</Text>
        </View>
        <AppIcon name="arrow-forward" color={colors.inkMuted} size={19} />
      </Pressable>

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/prompt-lab')}
        style={({ pressed }) => ({
          minHeight: 66,
          paddingHorizontal: 16,
          borderRadius: radii.medium,
          borderCurve: 'continuous',
          backgroundColor: colors.surfaceStrong,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 11,
          opacity: pressed ? 0.76 : 1,
        })}
      >
        <AppIcon name="science" color={colors.blue} size={21} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '800' }}>Prompt 匿名对比实验</Text>
          <Text style={{ color: colors.inkMuted, fontSize: 11.5 }}>5 个冻结问题 × 3 个方案；真实调用前显示费用上限</Text>
        </View>
        <AppIcon name="arrow-forward" color={colors.inkMuted} size={19} />
      </Pressable>

      <View style={{ flexDirection: 'row', gap: 9 }}>
        <ModeButton active={profile.kind === 'deepseek'} label="DeepSeek" onPress={() => selectKind('deepseek')} />
        <ModeButton active={profile.kind === 'mimo'} label="MiMo" onPress={() => selectKind('mimo')} />
        <ModeButton active={profile.kind === 'custom'} label="兼容服务" onPress={() => selectKind('custom')} />
      </View>

      <View style={{ padding: 17, borderRadius: radii.large, borderCurve: 'continuous', backgroundColor: colors.surfaceStrong, boxShadow: floatingShadow, gap: 15 }}>
        <Field label="服务名称">
          <TextInput
            value={profile.label}
            onChangeText={(label) => setProfile((current) => ({ ...current, label }))}
            editable={!busy && profile.kind === 'custom'}
            placeholder="例如 OpenRouter"
            placeholderTextColor={colors.gray}
            style={inputStyle}
          />
        </Field>
        <Field label="Base URL">
          <TextInput
            value={profile.baseUrl}
            onChangeText={(baseUrl) => setProfile((current) => ({ ...current, baseUrl }))}
            editable={!busy && profile.kind === 'custom'}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://api.example.com/v1"
            placeholderTextColor={colors.gray}
            style={inputStyle}
          />
          <Text selectable style={hintStyle}>应用会自动追加 /chat/completions；远程地址必须使用 HTTPS。</Text>
        </Field>
        <Field label="模型">
          <TextInput
            value={profile.model}
            onChangeText={(model) => setProfile((current) => ({ ...current, model }))}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="模型 ID"
            placeholderTextColor={colors.gray}
            style={inputStyle}
          />
        </Field>
        <Field label="API key">
          <TextInput
            value={apiKey}
            onChangeText={setApiKey}
            editable={!busy}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={hasSavedKey ? '已安全保存；留空则不修改' : '首次保存时填写'}
            placeholderTextColor={colors.gray}
            style={inputStyle}
          />
        </Field>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '700' }}>JSON mode</Text>
            <Text selectable style={hintStyle}>兼容服务不支持 response_format 时可关闭，应用仍会要求只返回 JSON。</Text>
          </View>
          <Switch
            value={profile.jsonMode}
            onValueChange={(jsonMode) => setProfile((current) => ({ ...current, jsonMode }))}
            disabled={Boolean(busy)}
            trackColor={{ false: colors.line, true: colors.blueSoft }}
            thumbColor={profile.jsonMode ? colors.blue : colors.gray}
          />
        </View>
        <Field label="输出 token 参数">
          <View style={{ flexDirection: 'row', gap: 7 }}>
            <OptionButton
              active={profile.tokenLimitField === 'max_tokens'}
              label="max_tokens"
              onPress={() => setProfile((current) => ({ ...current, tokenLimitField: 'max_tokens' }))}
            />
            <OptionButton
              active={profile.tokenLimitField === 'max_completion_tokens'}
              label="max_completion"
              onPress={() => setProfile((current) => ({ ...current, tokenLimitField: 'max_completion_tokens' }))}
            />
            <OptionButton
              active={profile.tokenLimitField === 'none'}
              label="不发送"
              onPress={() => setProfile((current) => ({ ...current, tokenLimitField: 'none' }))}
            />
          </View>
          <Text selectable style={hintStyle}>DeepSeek 通常使用 max_tokens；MiMo 和部分新版服务使用 max_completion_tokens。</Text>
        </Field>
      </View>

      <View style={{ padding: 15, borderRadius: radii.medium, borderCurve: 'continuous', backgroundColor: colors.amberSoft, gap: 6 }}>
        <Text selectable style={{ color: colors.ink, fontSize: 13, fontWeight: '800' }}>个人 BYOK 边界</Text>
        <Text selectable style={{ color: colors.inkMuted, fontSize: 12.5, lineHeight: 19 }}>
          自定义兼容只代表接口格式相近，不代表价格、隐私政策、模型能力或 JSON 行为相同。Root、调试注入或修改版 App 仍可能读取运行中的 key；共享给公众时应使用 Gateway。
        </Text>
      </View>

      {message ? (
        <Text selectable accessibilityLiveRegion="polite" style={{ color: message.startsWith('连接成功') || message.startsWith('已') ? colors.green : colors.coral, fontSize: 13, lineHeight: 19 }}>
          {message}
        </Text>
      ) : null}

      <View style={{ gap: 10 }}>
        <ActionButton label="安全保存" icon="lock" primary disabled={Boolean(busy)} loading={busy === 'save'} onPress={save} />
        <ActionButton label="测试连接" icon="wifi" disabled={Boolean(busy)} loading={busy === 'test'} onPress={confirmTest} />
        <ActionButton label="下次发送前重新询问" icon="privacy-tip" disabled={Boolean(busy) || !hasSavedKey} loading={busy === 'consent'} onPress={resetSendConsent} />
        <ActionButton label="删除本机配置" icon="delete-outline" destructive disabled={Boolean(busy) || (!hasSavedKey && !apiKey)} loading={busy === 'delete'} onPress={confirmDelete} />
      </View>
    </ScrollView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={{ gap: 7 }}><Text style={{ color: colors.ink, fontSize: 13, fontWeight: '700' }}>{label}</Text>{children}</View>;
}

function ModeButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        height: 46,
        borderRadius: 23,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? colors.ink : colors.surfaceStrong,
        borderWidth: active ? 0 : 1,
        borderColor: colors.line,
        opacity: pressed ? 0.78 : 1,
      })}
    ><Text style={{ color: active ? colors.white : colors.ink, fontSize: 14, fontWeight: '800' }}>{label}</Text></Pressable>
  );
}

function OptionButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 40,
        borderRadius: radii.small,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 5,
        backgroundColor: active ? colors.blueSoft : colors.canvas,
        borderWidth: 1,
        borderColor: active ? colors.blue : colors.line,
        opacity: pressed ? 0.76 : 1,
      })}
    ><Text numberOfLines={1} style={{ color: active ? colors.blue : colors.inkMuted, fontSize: 10.5, fontWeight: '700' }}>{label}</Text></Pressable>
  );
}

function ActionButton({ label, icon, primary, destructive, disabled, loading, onPress }: {
  label: string;
  icon: Parameters<typeof AppIcon>[0]['name'];
  primary?: boolean;
  destructive?: boolean;
  disabled: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  const foreground = primary ? colors.white : destructive ? colors.coral : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        height: 52,
        borderRadius: 26,
        borderCurve: 'continuous',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: primary ? colors.ink : colors.surfaceStrong,
        borderWidth: primary ? 0 : 1,
        borderColor: destructive ? colors.coralSoft : colors.line,
        opacity: disabled ? 0.45 : pressed ? 0.78 : 1,
      })}
    >
      {loading ? <ActivityIndicator color={foreground} /> : <AppIcon name={icon} color={foreground} size={19} />}
      <Text style={{ color: foreground, fontSize: 14, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  );
}

const inputStyle = {
  minHeight: 48,
  borderRadius: radii.small,
  borderCurve: 'continuous' as const,
  paddingHorizontal: 13,
  backgroundColor: colors.canvas,
  color: colors.ink,
  fontSize: 14,
};

const hintStyle = { color: colors.inkMuted, fontSize: 11.5, lineHeight: 17 } as const;
