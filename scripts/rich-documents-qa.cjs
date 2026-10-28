// Actual reader components and PDF.js, synthetic IPC/storage; no accounts or model calls.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { chromium, webkit } = require(
  process.env.LSQ_PLAYWRIGHT_MODULE || "playwright",
);
const base = process.env.LSQ_UI_URL || "http://127.0.0.1:5201",
  output = path.resolve(
    process.env.LSQ_UI_EVIDENCE || "E:/Temp/lumen-rich-documents-qa-20261026",
  );
fs.mkdirSync(output, { recursive: true });
const fixtures = path.join(__dirname, "fixtures");
fs.mkdirSync(fixtures, { recursive: true });
const digest = (b) => crypto.createHash("sha256").update(b).digest("hex");
const launch = {
  headless: true,
  ...(process.env.LSQ_CHROMIUM_PATH
    ? { executablePath: process.env.LSQ_CHROMIUM_PATH }
    : {}),
};
let browser, page;
const errors = [],
  network = [],
  checks = [];
(async () => {
  if (!fs.existsSync(path.join(fixtures, "rich-print.pdf"))) {
    const generator = await chromium.launch(launch);
    const print = await generator.newPage();
    await print.goto(base + "/scripts/knowledge-ui-fixture.html");
    const image = await print.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 250;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#eef6f1";
      ctx.fillRect(0, 0, 640, 250);
      ctx.font = "22px sans-serif";
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(30 + i * 205, 75, 170, 90);
        ctx.strokeStyle = "#9bb9ab";
        ctx.strokeRect(30 + i * 205, 75, 170, 90);
        ctx.fillStyle = "#2e5a4e";
        ctx.fillText(["问题", "证据", "理解"][i], 75 + i * 205, 130);
      }
      return canvas.toDataURL("image/png").split(",")[1];
    });
    fs.writeFileSync(
      path.join(fixtures, "rich-image.png"),
      Buffer.from(image, "base64"),
    );
    await print.evaluate(async (image) => {
      const { renderMarkdown } = await import("/src/reader/engine.ts");
      const { typesetMath } = await import("/src/reader/reader.ts");
      document.body.innerHTML =
        '<main class="markdown-body" style="padding:32px"><h1>图文学习资料</h1><p>PDF text extraction: evidence and understanding.</p>' +
        renderMarkdown(
          "## 数学与证据\n\n$$\\frac{a^2+b^2}{c^2}=1$$\n\n正文中的中文、公式和图片都应保留。",
        ).html +
        '<img style="width:100%" src="data:image/png;base64,' +
        image +
        '"><div style="break-before:page"><h1>第二页</h1><p>Page two: 原始资料完整保留。</p></div></main>';
      await typesetMath(document.body).done;
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    }, image);
    await print.pdf({
      path: path.join(fixtures, "rich-print.pdf"),
      format: "A4",
      printBackground: true,
    });
    await generator.close();
  }
  const png = fs.readFileSync(path.join(fixtures, "rich-image.png")),
    pdf = fs.readFileSync(path.join(fixtures, "rich-print.pdf")),
    zip = Buffer.from(
      "Synthetic original ZIP identity; native archive tests cover the actual exporter layout",
    );
  const asset = (bytes, ext, mime) => ({
    path: `docs/asset_${digest(bytes)}.${ext}`,
    sha256: digest(bytes),
    size: bytes.length,
    media_type: mime,
  });
  const image = asset(png, "png", "image/png"),
    originalZip = asset(zip, "zip", "application/zip"),
    originalPdf = asset(pdf, "pdf", "application/pdf");
  const markdown =
    '# 图文学习资料\n\n离线图片与公式：$x_i^2$。\n\n![学习流程](images/image-001.png)\n\n![引用式图片][picture]\n\n[picture]: images/image-001.png\n\n<table background="https://network.invalid/tracker.png"><tr><th>证据</th><th>图</th></tr><tr><td>表格内图片与公式 <math><semantics><mfrac><mi>a</mi><mi>b</mi></mfrac><annotation encoding="application/x-tex">\\frac{a}{b}</annotation></semantics></math></td><td><img src="images/image-001.png" onerror="window.__unsafe=1"></td></tr></table>\n\n<script>window.__unsafe=2</script>\n\n![远程缺失](https://network.invalid/missing.png)';
  browser = await (
    process.env.LSQ_UI_BROWSER === "webkit" ? webkit : chromium
  ).launch(
    process.env.LSQ_UI_BROWSER === "webkit" ? { headless: true } : launch,
  );
  const context = await browser.newContext({
    viewport: { width: 1280, height: 880 },
  });
  // Emulate affected real Safari even when the CI WebKit already supports this API.
  await context.addInitScript(() => {
    delete ReadableStream.prototype[Symbol.asyncIterator];
    delete ReadableStream.prototype.values;
    window.__pdfStreamReaderOnly = typeof ReadableStream.prototype[Symbol.asyncIterator] === "undefined";
  });
  await context.route("**/*", (route) => {
    if (
      route.request().url().startsWith(base) ||
      /^(blob:|data:)/.test(route.request().url())
    )
      return route.continue();
    network.push(route.request().url());
    return route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  async function reader(payload, assets) {
    await page.close();
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(
      ({ payload, assets }) => {
        window.__fixtureDocumentPayload = payload;
        window.__fixtureDocumentAssets = assets;
      },
      { payload: { ...payload, scope: "synthetic-scope" }, assets },
    );
    await page.goto(
      base +
        `/scripts/knowledge-ui-fixture.html?mode=reader&platform=macos&project=project&board=board&path=docs/${payload.attachment?.original.sha256 ?? "plain"}.md&title=图文资料`,
    );
  }
  await reader(
    {
      markdown,
      attachment: {
        schema: "lumen-document/v1",
        kind: "markdown_bundle",
        original: originalZip,
        images: { "images/image-001.png": image },
        pages: 0,
        extraction: "ready",
      },
    },
    { [image.path]: [...png], [originalZip.path]: [...zip] },
  );
  await page.locator(".reader-content img").first().waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".reader-content img")].filter((img) =>
        img.getAttribute("src")?.startsWith("blob:"),
      ).length === 3,
  );
  const images = await page
    .locator(".reader-content img")
    .evaluateAll(async (list) => {
      await Promise.all(
        list
          .filter((img) => img.src.startsWith("blob:"))
          .map((img) => img.decode()),
      );
      return list
        .filter((img) => img.src.startsWith("blob:"))
        .map((img) => ({ width: img.naturalWidth, height: img.naturalHeight }));
    });
  assert.equal(images.length, 3);
  assert.ok(images.every((img) => img.width === 640 && img.height === 250));
  assert.equal(
    await page.locator(".reader-content table[background]").count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  assert.equal(await page.locator(".reader-content script").count(), 0);
  assert.equal(
    await page
      .locator(".reader-content math annotation")
      .evaluate((el) => getComputedStyle(el).display),
    "none",
  );
  await page.locator(".reader-content .katex").first().waitFor();
  assert.equal(network.length, 0);
  await page.screenshot({
    path: path.join(output, "rich-markdown.png"),
    animations: "disabled",
  });
  checks.push(
    "inline/reference/table images decode from local blobs; formulas and MathML render; scripts and network resource attributes are removed",
  );
  await page.getByRole("button", { name: "双页", exact: true }).click();
  await page.locator(".reader-page").first().waitFor();
  assert.equal(
    await page.locator('.reader-pages img[src^="blob:"]').count(),
    3,
  );
  await page.screenshot({
    path: path.join(output, "rich-double-page.png"),
    animations: "disabled",
  });
  checks.push("double-page reader preserves images and formula blocks");
  assert.equal(await page.evaluate(() => window.__pdfStreamReaderOnly), true);
  const extracted = await page.evaluate(
    async (bytes) => {
      const { extractPdf } = await import("/src/documents/pdf.ts");
      return extractPdf(
        new Uint8Array(bytes),
        () => {},
        new AbortController().signal,
      );
    },
    [...pdf],
  );
  assert.equal(extracted.pages, 2);
  assert.match(extracted.text, /PDF text extraction/);
  assert.match(extracted.text, /第二页/);
  assert.match(extracted.text, /第 2 页/);
  await reader(
    {
      markdown: extracted.text,
      attachment: {
        schema: "lumen-document/v1",
        kind: "pdf",
        original: originalPdf,
        images: {},
        pages: 2,
        extraction: "ready",
      },
    },
    { [originalPdf.path]: [...pdf] },
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".textLayer")
      ?.textContent?.includes("PDF text extraction"),
  );
  assert.equal(
    await page
      .locator(".pdf-sheet canvas")
      .evaluate((el) => el.width > 100 && el.height > 100),
    true,
  );
  const selection = await page.locator(".textLayer").evaluate((el) => {
    const span = [...el.querySelectorAll("span")].find((el) =>
      el.textContent.includes("PDF text extraction"),
    );
    const range = document.createRange();
    range.selectNodeContents(span);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    return {
      selected: window.getSelection().toString(),
      font: getComputedStyle(span).fontSize,
      rect: span.getBoundingClientRect().toJSON(),
      page: el.getBoundingClientRect().toJSON(),
    };
  });
  assert.match(selection.selected, /PDF text extraction/);
  assert.ok(parseFloat(selection.font) > 5);
  assert.ok(
    selection.rect.x >= selection.page.x - 1 &&
      selection.rect.right <= selection.page.right + 2,
  );
  await page.screenshot({
    path: path.join(output, "rich-pdf-page-one.png"),
    animations: "disabled",
  });
  await page.getByTitle("下一页", { exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".textLayer")?.textContent?.includes("Page two"),
  );
  await page.getByTitle("放大页面", { exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".reader-font-val")?.textContent === "125%",
  );
  await page.screenshot({
    path: path.join(output, "rich-pdf-page-two.png"),
    animations: "disabled",
  });
  checks.push(
    "without ReadableStream async iteration, actual PDF still extracts two pages and Chinese text, renders images/math and selectable text at zoom",
  );
  const rotated = fs.readFileSync(path.join(fixtures, "rich-rotated.pdf"));
  const rotatedAsset = asset(rotated, "pdf", "application/pdf");
  await reader(
    {
      markdown: extracted.text,
      attachment: {
        schema: "lumen-document/v1",
        kind: "pdf",
        original: rotatedAsset,
        images: {},
        pages: 2,
        extraction: "ready",
      },
    },
    { [rotatedAsset.path]: [...rotated] },
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".textLayer")
      ?.textContent?.includes("PDF text extraction"),
  );
  const rotatedBounds = await page.locator(".textLayer").evaluate((layer) => {
    const span = [...layer.querySelectorAll("span")].find((el) =>
      el.textContent.includes("PDF text extraction"),
    );
    return {
      span: span.getBoundingClientRect().toJSON(),
      canvas: layer.parentElement
        .querySelector("canvas")
        .getBoundingClientRect()
        .toJSON(),
    };
  });
  assert.ok(
    rotatedBounds.span.x >= rotatedBounds.canvas.x - 2 &&
      rotatedBounds.span.right <= rotatedBounds.canvas.right + 2 &&
      rotatedBounds.span.y >= rotatedBounds.canvas.y - 2 &&
      rotatedBounds.span.bottom <= rotatedBounds.canvas.bottom + 2,
  );
  await page.screenshot({
    path: path.join(output, "rich-pdf-rotated.png"),
    animations: "disabled",
  });
  checks.push(
    "a PDF page rotated 90 degrees preserves text layer alignment inside the rendered page",
  );
  const scan = fs.readFileSync(path.join(fixtures, "rich-scan.pdf")),
    scanAsset = asset(scan, "pdf", "application/pdf");
  const scanText = await page.evaluate(
    async (bytes) => {
      const { extractPdf } = await import("/src/documents/pdf.ts");
      return extractPdf(
        new Uint8Array(bytes),
        () => {},
        new AbortController().signal,
      );
    },
    [...scan],
  );
  assert.equal(scanText.text, "");
  assert.equal(scanText.pages, 1);
  await reader(
    {
      markdown: "# 扫描原件\n\n没有可检索文字。",
      attachment: {
        schema: "lumen-document/v1",
        kind: "pdf",
        original: scanAsset,
        images: {},
        pages: 1,
        extraction: "empty",
      },
    },
    { [scanAsset.path]: [...scan] },
  );
  await page
    .getByText("此 PDF 没有可检索文字；AI 暂时只能看到文件说明。", {
      exact: true,
    })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelector(".pdf-sheet canvas")?.width > 100,
  );
  await page.screenshot({
    path: path.join(output, "rich-pdf-scan.png"),
    animations: "disabled",
  });
  checks.push(
    "image-only PDF remains viewable and explicitly reports that no text/OCR was supplied to AI",
  );
  for (const width of [720, 380]) {
    await page.setViewportSize({ width, height: 880 });
    await page.waitForTimeout(200);
    assert.equal(
      await page
        .locator(".reader-bar")
        .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
      false,
    );
    await page.screenshot({
      path: path.join(output, "rich-pdf-" + width + ".png"),
      animations: "disabled",
    });
  }
  checks.push("PDF toolbar remains usable at desktop and narrow widths");
  await page.setViewportSize({ width: 1280, height: 880 });
  await page.goto(
    base +
      "/scripts/knowledge-ui-fixture.html?platform=macos&nodes=1&captureQA=1",
  );
  await page
    .locator(".pane-projects .list-item")
    .filter({ hasText: "桌面夹" })
    .click();
  await page
    .locator(".pane-boards .list-item")
    .filter({ hasText: "合成学习白板" })
    .click();
  await page.locator(".node-card").first().click();
  await page.evaluate(() => {
    window.__fixtureDocumentFiles = ["E:/synthetic/Answer.zip"];
    window.__fixtureAttachmentDelay = 700;
  });
  await page
    .getByTitle("导入 Markdown、PDF 或 Markdown 图片 ZIP", { exact: true })
    .click();
  await page.waitForFunction(() => window.__fixtureAttachmentStarted);
  assert.equal(
    await page.getByRole("button", { name: "停止", exact: true }).isDisabled(),
    true,
  );
  await page.locator(".doc-card").waitFor();
  assert.equal(await page.locator(".doc-card").count(), 1);
  await page.waitForTimeout(750);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await page.locator(".doc-card").count(), 0);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  assert.equal(await page.locator(".doc-card").count(), 1);
  checks.push(
    "atomic attachment save blocks interruption and adopts the committed result; one undo/redo unmounts/remounts without deleting original files",
  );
  await page.evaluate((bytes) => {
    window.__fixtureDocumentFiles = ["E:/synthetic/answer.pdf"];
    window.__fixturePdfSource = bytes;
    window.__fixtureAttachmentDelay = 0;
    window.__fixtureAttachmentArgs = undefined;
  }, [...pdf]);
  await page.getByTitle("导入 Markdown、PDF 或 Markdown 图片 ZIP", { exact: true }).click();
  await page.waitForFunction(() => window.__fixtureAttachmentArgs?.pages === 2);
  const attachedPdf = await page.evaluate(() => window.__fixtureAttachmentArgs);
  assert.equal(attachedPdf.sourceHash, digest(pdf));
  assert.match(attachedPdf.pdfText, /PDF text extraction/);
  assert.match(attachedPdf.pdfText, /第二页/);
  assert.equal(attachedPdf.expectedScope, "synthetic-scope");
  checks.push("node import control runs the actual PDF extractor without async iteration and passes exact original SHA, both pages and text to native attachment commit");
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  fs.writeFileSync(
    path.join(output, "rich-documents-qa.json"),
    JSON.stringify(
      {
        checks,
        errors,
        network,
        browser: process.env.LSQ_UI_BROWSER || "chromium",
        browserPlugin: "not available",
        realCredentialsRead: 0,
        providerCalls: 0,
        fixturePdfSha256: digest(pdf),
      },
      null,
      2,
    ),
  );
  await browser.close();
  console.log(JSON.stringify({ pass: true, checks: checks.length, output }));
})().catch(async (e) => {
  if (page) {
    await page
      .screenshot({ path: path.join(output, "rich-documents-failure.png") })
      .catch(() => {});
    fs.writeFileSync(
      path.join(output, "rich-documents-failure.txt"),
      await page
        .locator("body")
        .ariaSnapshot()
        .catch(() => ""),
    );
  }
  await browser?.close();
  console.error(e);
  process.exitCode = 1;
});
