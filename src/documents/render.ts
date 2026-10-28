import createDOMPurify from "dompurify";
import {
  createEngine,
  renderMarkdown,
  type RenderResult,
} from "../reader/engine";
import { imageAlias, type DocumentMetadata } from "./core";
/** Bundle HTML supports the exporter's complex tables, never scripts, styles or network images. */
export function renderRichMarkdown(
  markdown: string,
  metadata: DocumentMetadata,
  urls: Record<string, string>,
): RenderResult {
  const engine = createEngine(true);
  const rendered = renderMarkdown(markdown, engine);
  const purifier = createDOMPurify(window);
  purifier.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "src") {
      const alias = imageAlias(data.attrValue);
      const asset = alias && metadata.images[alias];
      data.attrValue = asset ? (urls[asset.path] ?? "") : "";
      data.keepAttr = !!data.attrValue;
      if (data.keepAttr && data.attrValue.startsWith("blob:")) {
        (_node as Element).setAttribute("src", data.attrValue);
        data.forceKeepAttr = true;
      }
    }
  });
  purifier.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "IMG" && !(node as Element).hasAttribute("src"))
      (node as Element).setAttribute(
        "alt",
        ((node as Element).getAttribute("alt") || "图片") +
          "（未随资料保存或尚未载入）",
      );
  });
  const clean = (html: string) =>
    purifier.sanitize(html, {
      USE_PROFILES: { html: true, mathMl: true },
      ADD_TAGS: ["semantics", "annotation"],
      ADD_ATTR: ["encoding"],
      FORBID_TAGS: [
        "style",
        "form",
        "input",
        "button",
        "iframe",
        "object",
        "embed",
        "video",
        "audio",
        "source",
        "link",
        "meta",
        "base",
      ],
      FORBID_ATTR: [
        "style",
        "srcset",
        "background",
        "poster",
        "ping",
        "action",
        "formaction",
      ],
      ALLOW_DATA_ATTR: true,
    });
  return {
    html: clean(rendered.html),
    toc: rendered.toc.map((item) => ({ ...item, html: clean(item.html) })),
  };
}
