import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { File, Paths } from "expo-file-system";
import Native from "@/modules/expo-content-extractor";
import { verifiedAssetUri } from "@/data/rich-document-files";
import type { DocumentMetadata } from "@/data/rich-document";
import { WorkspaceButton } from "./workspace-controls";
import { colors } from "@/theme/tokens";
import { useSQLiteContext } from "expo-sqlite";
export function PdfDocumentReader({
  metadata,
  documentId,
  onPosition,
}: {
  metadata: DocumentMetadata;
  documentId: string;
  onPosition: (anchor: string, ratio: number) => void;
}) {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [restored, setRestored] = useState(false);
  const [page, setPage] = useState(1),
    [draft, setDraft] = useState("1"),
    [count, setCount] = useState(metadata.pages || 1),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState("");
  const [image, setImage] = useState<{
    uri: string;
    width: number;
    height: number;
  } | null>(null);
  const { width } = useWindowDimensions();
  useEffect(() => {
    let active = true;
    void db
      .getFirstAsync<{ anchor: string }>(
        "SELECT anchor FROM reading_positions WHERE id=?",
        documentId,
      )
      .then((row) => {
        if (!active) return;
        const match = /^pdf:([1-9]\d*)$/.exec(row?.anchor ?? "");
        if (match) {
          const n = Math.min(metadata.pages || 2000, Number(match[1]));
          setPage(n);
          setDraft(String(n));
        }
        setRestored(true);
      })
      .catch(() => {
        if (active) setRestored(true);
      });
    return () => {
      active = false;
    };
  }, [db, documentId, metadata.pages]);
  useEffect(() => {
    if (!restored) return;
    let active = true,
      created = "";
    const discard = () => {
      if (
        created.startsWith(
          Paths.cache.uri.replace(/\/?$/, "/") + "rich-pdf-pages/",
        )
      )
        try {
          new File(created).delete();
        } catch {
          /* Only this reader's generated raster. */
        }
    };
    setImage(null);
    setError("");
    void (async () => {
      const uri = await verifiedAssetUri(metadata.original);
      if (!active) return;
      const result = await Native.renderPdfPageAsync(
        uri,
        page - 1,
        Math.min(2048, Math.ceil((width - 24) * 2 * zoom)),
      );
      created = result.uri;
      if (active) {
        setImage(result);
        setCount(result.pages);
      } else discard();
    })().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
      discard();
    };
  }, [metadata.original, page, width, zoom, restored]);
  const go = (n: number) => {
    if (!restored) return;
    const value = Math.max(
      1,
      Math.min(count, Math.trunc(Number.isFinite(n) ? n : 1)),
    );
    setPage(value);
    setDraft(String(value));
    onPosition(`pdf:${value}`, (value - 1) / Math.max(1, count - 1));
  };
  return (
    <View style={{ flex: 1, paddingBottom: insets.bottom }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
        }}
      >
        <WorkspaceButton
          label="‹"
          accessibilityLabel="上一页"
          secondary
          disabled={!restored || page <= 1}
          onPress={() => go(page - 1)}
        />
        <TextInput
          accessibilityLabel="PDF页码"
          editable={restored}
          keyboardType="number-pad"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => go(Number(draft) || 1)}
          onBlur={() => go(Number(draft) || 1)}
          style={{
            minWidth: 44,
            textAlign: "center",
            padding: 8,
            color: colors.ink,
            backgroundColor: colors.surfaceStrong,
            borderRadius: 12,
          }}
        />
        <Text style={{ color: colors.inkMuted }}>/ {count}</Text>
        <WorkspaceButton
          label="›"
          accessibilityLabel="下一页"
          secondary
          disabled={!restored || page >= count}
          onPress={() => go(page + 1)}
        />
        <WorkspaceButton
          label={`${Math.round(zoom * 100)}%`}
          secondary
          onPress={() => setZoom((v) => (v >= 2 ? 1 : v + 0.25))}
        />
      </View>
      {error ? (
        <Text selectable style={{ padding: 18, color: colors.coral }}>
          {error}；可以导出原件，或切换文字阅读。
        </Text>
      ) : !image ? (
        <ActivityIndicator color={colors.ink} style={{ padding: 32 }} />
      ) : (
        <ScrollView>
          <ScrollView horizontal contentContainerStyle={{ padding: 12 }}>
            <Image
              accessibilityLabel={`PDF第${page}页`}
              source={{ uri: image.uri }}
              resizeMode="contain"
              style={{
                width: (width - 24) * zoom,
                height: ((width - 24) * zoom * image.height) / image.width,
                backgroundColor: "#fff",
                borderRadius: 8,
              }}
            />
          </ScrollView>
        </ScrollView>
      )}
      {metadata.extraction !== "ready" ? (
        <Text style={{ padding: 12, color: colors.inkMuted, fontSize: 12 }}>
          原件可阅读；未提取到文字，AI尚未读取图像内容。
        </Text>
      ) : null}
    </View>
  );
}
