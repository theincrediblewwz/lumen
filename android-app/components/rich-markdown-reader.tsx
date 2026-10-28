import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { marked } from "marked";
import katex from "katex";
import { File } from "expo-file-system";
import Native from "@/modules/expo-content-extractor";
import { splitDocument, type DocumentMetadata } from "@/data/rich-document";
import { verifiedAssetUri } from "@/data/rich-document-files";
import {
  prepareMarkdownMathForRenderer,
  decodeMarkdownMathPayload,
  MARKDOWN_MATH_SENTINEL,
} from "@/ai/markdown-math";
import { richKatexCss } from "./rich-katex-css";
import { colors } from "@/theme/tokens";
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function richHtml(raw: string, metadata: DocumentMetadata) {
  const { markdown } = splitDocument(raw);
  const aliases = Object.fromEntries(
    Object.entries(metadata.images).map(([alias, ref]) => [alias, ref.sha256]),
  );
  let html = await Native.sanitizeDocumentHtmlAsync(
    marked.parse(
      prepareMarkdownMathForRenderer(markdown).replaceAll(
        MARKDOWN_MATH_SENTINEL,
        "lumen-math-v1:",
      ),
      { async: false },
    ) as string,
    aliases,
  );
  const data = new Map<string, string>();
  let missing = 0;
  for (const ref of Object.values(metadata.images)) {
    if (data.has(ref.sha256)) continue;
    try {
      const file = new File(await verifiedAssetUri(ref));
      data.set(
        ref.sha256,
        `data:${ref.media_type};base64,${await file.base64()}`,
      );
    } catch {
      missing++;
    }
  }
  html = html.replace(
    /data-lumen-image="([a-f0-9]{64})"/g,
    (_, hash: string) =>
      data.has(hash) ? `src="${data.get(hash)}"` : 'alt="[图片缺失或校验失败]"',
  );
  html = html.replace(/<code>([^<]+)<\/code>/g, (all, content: string) => {
    if (!content.startsWith("lumen-math-v1:")) return all;
    const payload = content.slice("lumen-math-v1:".length),
      display = payload.startsWith("display:");
    try {
      return katex.renderToString(
        decodeMarkdownMathPayload(payload.slice(display ? 8 : 7)),
        {
          displayMode: display,
          throwOnError: false,
          trust: false,
          strict: "warn",
          output: "htmlAndMathml",
        },
      );
    } catch {
      return `<code>${escape(content)}</code>`;
    }
  });
  const notice = missing
    ? "<aside>有图片缺失或校验失败，请恢复原件或完成同步；文字仍可阅读。</aside>"
    : "";
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'"><style>${richKatexCss}body{margin:0;padding:22px 18px 60px;color:#20201f;background:#f6f1e8;font:17px/1.75 -apple-system,Roboto,sans-serif;overflow-wrap:anywhere}h1{font-size:27px}h2{font-size:22px}img{max-width:100%;height:auto;border-radius:12px}table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;margin:18px 0}th,td{border:1px solid #d5ded8;padding:10px;min-width:70px}pre{overflow:auto;padding:14px;background:#eeeae3;border-radius:12px}blockquote,aside{margin:16px 0;padding:12px;border-left:3px solid #b5c9bd;background:#ecefe8}.katex-display{overflow:auto;padding:6px 0}a{color:#5d82d7}button,input{display:none}</style></head><body>${notice}${html}</body></html>`;
}
export function RichMarkdownReader({
  raw,
  metadata,
}: {
  raw: string;
  metadata: DocumentMetadata;
}) {
  const [html, setHtml] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setHtml("");
    setError("");
    void richHtml(raw, metadata)
      .then((v) => {
        if (active) setHtml(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [raw, metadata]);
  if (error)
    return (
      <Text selectable style={{ padding: 18, color: colors.coral }}>
        {error}；可切换“文字”继续阅读。
      </Text>
    );
  if (!html)
    return <ActivityIndicator color={colors.ink} style={{ padding: 32 }} />;
  return (
    <View style={{ flex: 1 }}>
      <WebView
        accessibilityLabel="图文资料原版阅读"
        source={{ html, baseUrl: "about:blank" }}
        originWhitelist={["about:blank"]}
        javaScriptEnabled={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" ||
          request.url.startsWith("about:blank#")
        }
        style={{ flex: 1, backgroundColor: colors.canvas }}
        onError={() => setError("图文排版暂时不可用")}
      />
    </View>
  );
}
