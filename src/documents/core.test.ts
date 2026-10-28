import { expect, it } from "vitest";
import { DOCUMENT_PREFIX, splitDocument, imageAlias } from "./core";
import { renderMarkdown } from "../reader/engine";
it("leaves ordinary Markdown byte-for-byte and separates metadata from readable text", () => {
  const body = "# 正文\n\n$x_i$\n\n![图](images/image-001.png)";
  expect(splitDocument(body).markdown).toBe(body);
  const hash = "a".repeat(64);
  const meta = {
    schema: "lumen-document/v1",
    kind: "markdown_bundle",
    original: {
      path: `docs/asset_${hash}.zip`,
      sha256: hash,
      size: 5,
      media_type: "application/zip",
    },
    images: {},
    pages: 0,
    extraction: "ready",
  };
  expect(
    splitDocument(DOCUMENT_PREFIX + JSON.stringify(meta) + "\n-->\n\n" + body),
  ).toEqual({ markdown: body, attachment: meta });
  expect(() => splitDocument(DOCUMENT_PREFIX + "{}")).toThrow();
  expect(() =>
    splitDocument(
      DOCUMENT_PREFIX +
        JSON.stringify({
          ...meta,
          original: { ...meta.original, path: "../secret" },
        }) +
        "\n-->\n\n" +
        body,
    ),
  ).toThrow();
});
it("never turns a relative image into a host path or automatic remote request", () => {
  expect(imageAlias("./images/图片.png")).toBe("images/图片.png");
  for (const url of [
    "../x",
    "images/%2e%2e/secret",
    "file:///secret",
    "https://example.invalid/x",
    "/etc/x",
    "images\\x",
  ])
    expect(imageAlias(url)).toBeNull();
  const { html } = renderMarkdown(
    "![remote](https://example.invalid/tracker.png)",
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("remote");
});
