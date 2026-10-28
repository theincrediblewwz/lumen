import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { URL } from "node:url";
import type { SQLiteDatabase } from "expo-sqlite";
import { migrateDatabase } from "../data/database";
import {
  createFreeBoard,
  listNodeDocuments,
  saveDocumentRevision,
} from "../data/node-workspace";
import {
  plainMarkdown,
  prepareRichDocument,
  readArchive,
  writeArchive,
  strToU8,
  strFromU8,
} from "../data/rich-archive";
import { attachRichDocument } from "../data/rich-document-store";
import {
  splitDocument,
  documentText,
  withDocumentText,
} from "../data/rich-document";
import { referenceBlocks } from "../data/reading-reference";
import { readingBlocks } from "../data/reading-position";
import {
  createPortableManifest,
  importPortableManifestWithMapping,
} from "../data/portable-knowledge";
import {
  nativeBoardPackage,
  lumenBoardPackage,
  parseBoardPackage,
} from "../data/rich-board-package";
import {
  validateOriginalAssets,
  type OriginalAsset,
} from "../data/rich-backup";
import {
  writeLocalBackupSnapshot,
  type LocalBackupSnapshot,
  type BackupFileStore,
} from "../data/local-backup-format";
import { parseLocalBackupSnapshot } from "../data/local-backup-import";
import { importLocalBackupAsCopies } from "../data/local-backup-import";
import { createConversation } from "../data/conversations";
import { prepareDiscussion } from "../ai/discussion-context";
import { deleteProjectSourceItem } from "../data/source-items";

const hash = async (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const png = new Uint8Array(
  readFileSync(
    new URL("../../scripts/fixtures/rich-image.png", import.meta.url),
  ),
);
const pdf = new Uint8Array(
  readFileSync(
    new URL("../../scripts/fixtures/rich-print.pdf", import.meta.url),
  ),
);
const zip = (
  body = '# 图文知识\n\n关键证据 $x_i^2$\n\n![图](images/image-001.png)\n\n![引用图][img]\n\n[img]: images/image-001.png\n\n<table><tr><td>证据</td><td><img src="images/image-001.png"></td></tr></table>',
) =>
  writeArchive({
    "answer.md": strToU8(body),
    "images/image-001.png": png,
    "EXPORT-NOTES.md": strToU8("合成导出说明"),
  });
async function fixture() {
  const raw = new DatabaseSync(":memory:");
  const api = {
    execAsync: async (sql: string) => {
      raw.exec(sql);
    },
    runAsync: async (sql: string, ...args: any[]) =>
      raw.prepare(sql).run(...args),
    getFirstAsync: async (sql: string, ...args: any[]) =>
      raw.prepare(sql).get(...args) ?? null,
    getAllAsync: async (sql: string, ...args: any[]) =>
      raw.prepare(sql).all(...args),
    withExclusiveTransactionAsync: async (
      fn: (tx: SQLiteDatabase) => Promise<unknown>,
    ) => {
      raw.exec("BEGIN IMMEDIATE");
      try {
        await fn(api as unknown as SQLiteDatabase);
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const db = api as unknown as SQLiteDatabase;
  await migrateDatabase(db);
  const board = await createFreeBoard(db, "图文测试", "原始正文");
  return { db, raw, board };
}
async function mounted() {
  const f = await fixture();
  const prepared = await prepareRichDocument("Answer.zip", zip(), hash);
  const uris = new Map(
    Object.values(prepared.metadata.images)
      .concat(prepared.metadata.original)
      .map((ref) => [ref.sha256, `file:///private/sync-blobs/${ref.sha256}`]),
  );
  const documentId = await attachRichDocument(
    f.db,
    f.board.projectId,
    f.board.nodeId,
    prepared,
    uris,
  );
  return { ...f, prepared, documentId };
}
async function packedFixture() {
  const f = await mounted();
  const manifest = await createPortableManifest(f.db, f.board.projectId);
  const originals: OriginalAsset[] = (manifest.sourceItems ?? []).map((s) => ({
    projectId: manifest.project.id,
    sourceId: s.id,
    sha256: s.contentHash,
    size: s.byteSize,
    mediaType: s.mediaType,
  }));
  const read = async (ref: OriginalAsset) =>
    Object.values(f.prepared.files).find(
      (b) => createHash("sha256").update(b).digest("hex") === ref.sha256,
    )!;
  return { ...f, manifest, originals, read };
}

test("exporter ZIP preserves exact Markdown, binary original and locally addressed inline/reference/table image", async () => {
  const bytes = zip();
  const result = await prepareRichDocument("Answer.zip", bytes, hash);
  assert.equal(
    documentText(result.body),
    strFromU8(readArchive(bytes)["answer.md"]),
  );
  assert.equal(
    result.metadata.images["images/image-001.png"].sha256,
    await hash(png),
  );
  assert.deepEqual(result.files[result.metadata.original.path], bytes);
  assert.equal(result.metadata.kind, "markdown_bundle");
});
test("ZIP rejects prototype keys, traversal, directory aliases, corruption and unknown executable content", async () => {
  for (const name of [
    "../x.png",
    "docs/CON.txt",
    "images/x.png.",
    "__proto__",
  ]) {
    const bytes = writeArchive({
      "answer.md": strToU8("a"),
      badname__: strToU8("unknown"),
    });
    if (name === "__proto__") {
      const b = Buffer.from(bytes);
      const from = Buffer.from("badname__"),
        to = Buffer.from("__proto__");
      let i = b.indexOf(from);
      while (i >= 0) {
        b.set(to, i);
        i = b.indexOf(from, i + to.length);
      }
      assert.throws(() => readArchive(b));
    } else assert.throws(() => writeArchive({ [name]: strToU8("x") }));
  }
  assert.throws(
    () =>
      readArchive(
        writeArchive({
          "answer.md": strToU8("x"),
          "New/a.png": png,
          "new/b.png": png,
        }),
      ),
    /冲突/,
  );
  await assert.rejects(
    prepareRichDocument(
      "x.zip",
      writeArchive({ "answer.md": strToU8("a"), "bad.exe": strToU8("a") }),
      hash,
    ),
    /未知/,
  );
  const bytes = zip();
  const corrupted = bytes.slice();
  corrupted[50] ^= 1;
  assert.throws(() => readArchive(corrupted));
});
test("PDF has independent original bytes, readable page provenance and explicit image-only state", async () => {
  const result = await prepareRichDocument("paper.pdf", pdf, hash, [
    { page: 1, text: "第一页证据" },
    { page: 2, text: "第二页结论" },
  ]);
  assert.match(documentText(result.body), /第 2 页\n\n第二页结论/);
  assert.deepEqual(result.files[result.metadata.original.path], pdf);
  const scan = await prepareRichDocument("scan.pdf", pdf, hash, [
    { page: 1, text: "" },
  ]);
  assert.equal(scan.metadata.extraction, "empty");
  assert.match(documentText(scan.body), /AI尚未读取图像/);
});
test("invalid metadata cannot crash PDF controls; body edits and both block indexes keep the attachment header", async () => {
  const prepared = await prepareRichDocument("paper.pdf", pdf, hash, [
    { page: 1, text: "## 证据\n\n段落" },
  ]);
  for (const value of [{}, -1, "100", null]) {
    const broken = prepared.body.replace(
      '"pages":1',
      `"pages":${JSON.stringify(value)}`,
    );
    assert.throws(() => splitDocument(broken));
  }
  assert.deepEqual(
    readingBlocks(prepared.body),
    readingBlocks(documentText(prepared.body)),
  );
  assert.equal(
    referenceBlocks(prepared.body).length,
    referenceBlocks(documentText(prepared.body)).length,
  );
  const edited = withDocumentText(prepared.body, "# 新正文");
  assert.deepEqual(splitDocument(edited).attachment, prepared.metadata);
  assert.equal(documentText(edited), "# 新正文");
});
test("native SQLite attachment is idempotent, has intact source dependencies, and guards original deletion", async (t) => {
  const f = await mounted();
  t.after(() => f.raw.close());
  const uris = new Map(
    Object.values(f.prepared.metadata.images)
      .concat(f.prepared.metadata.original)
      .map((ref) => [ref.sha256, `file:///private/sync-blobs/${ref.sha256}`]),
  );
  await attachRichDocument(
    f.db,
    f.board.projectId,
    f.board.nodeId,
    f.prepared,
    uris,
  );
  assert.equal((await listNodeDocuments(f.db, f.board.nodeId)).length, 2);
  assert.equal(
    (
      f.raw
        .prepare("SELECT COUNT(*) AS n FROM source_items WHERE project_id=?")
        .get(f.board.projectId) as any
    ).n,
    2,
  );
  assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
  const source = f.raw
    .prepare("SELECT id FROM source_items WHERE project_id=? LIMIT 1")
    .get(f.board.projectId) as any;
  await assert.rejects(deleteProjectSourceItem(f.db, source.id), /引用/);
});
test("late SQL failure rolls back rich document, sources and node link without changing original primary", async (t) => {
  const f = await fixture();
  t.after(() => f.raw.close());
  const prepared = await prepareRichDocument("paper.pdf", pdf, hash, [
    { page: 1, text: "证据" },
  ]);
  const uris = new Map([
    [
      prepared.metadata.original.sha256,
      `file:///private/sync-blobs/${prepared.metadata.original.sha256}`,
    ],
  ]);
  const before = f.raw.prepare("SELECT COUNT(*) AS n FROM documents").get();
  f.raw.exec(
    "CREATE TRIGGER fail_attach BEFORE INSERT ON node_documents BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await assert.rejects(
    attachRichDocument(f.db, f.board.projectId, f.board.nodeId, prepared, uris),
    /synthetic/,
  );
  assert.deepEqual(
    f.raw.prepare("SELECT COUNT(*) AS n FROM documents").get(),
    before,
  );
  assert.equal(
    (f.raw.prepare("SELECT COUNT(*) AS n FROM source_items").get() as any).n,
    0,
  );
});
test("shared image bytes deduplicate across independent Markdown bundles", async (t) => {
  const f = await mounted();
  t.after(() => f.raw.close());
  const prepared = await prepareRichDocument(
    "second.zip",
    zip("# 独立资料\n\n![图](images/image-001.png)"),
    hash,
  );
  const uris = new Map(
    Object.values(prepared.metadata.images)
      .concat(prepared.metadata.original)
      .map((ref) => [ref.sha256, `file:///private/sync-blobs/${ref.sha256}`]),
  );
  await attachRichDocument(
    f.db,
    f.board.projectId,
    f.board.nodeId,
    prepared,
    uris,
  );
  assert.equal(
    (
      f.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM source_items WHERE project_id=? AND kind='image'",
        )
        .get(f.board.projectId) as any
    ).n,
    1,
  );
});
test("node and whiteboard AI previews see readable attached content, not JSON metadata or binary hashes", async (t) => {
  const f = await mounted();
  t.after(() => f.raw.close());
  for (const node of [f.board.nodeId, undefined]) {
    const conversation = await createConversation(
      f.db,
      f.board.projectId,
      node ?? null,
      "资料讨论",
    );
    const result = await prepareDiscussion(f.db, conversation, "关键证据");
    assert.match(result.preview, /关键证据/);
    assert.doesNotMatch(
      result.preview,
      /lumen-document\/v1|"media_type"|"sha256"/,
    );
  }
});
test("complete Android and desktop-compatible packages roundtrip every image and PDF hash into new SQLite board identities", async (t) => {
  const f = await packedFixture();
  t.after(() => f.raw.close());
  for (const writer of [nativeBoardPackage, lumenBoardPackage]) {
    const bytes = await writer(f.manifest, f.originals, f.read, hash);
    const parsed = await parseBoardPackage(bytes, hash);
    assert.equal(parsed.originals.length, 2);
    for (const ref of parsed.originals)
      assert.equal(
        await hash(parsed.files[`assets/${ref.sha256}.bin`]),
        ref.sha256,
      );
    const uris = new Map(
      parsed.originals.map((ref) => [
        ref.sourceId,
        `file:///private/sync-blobs/${ref.sha256}`,
      ]),
    );
    const mapping = await importPortableManifestWithMapping(
      f.db,
      parsed.manifest,
      uris,
    );
    assert.notEqual(mapping.projectId, f.board.projectId);
    const copied = await createPortableManifest(f.db, mapping.projectId);
    assert.ok(
      copied.documents.some((doc) =>
        documentText(doc.body).includes("关键证据"),
      ),
    );
    assert.equal(copied.sourceItems?.length, 2);
    assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
  }
});
test("missing or corrupted rich originals prevent export/import rather than producing an incomplete board", async (t) => {
  const f = await packedFixture();
  t.after(() => f.raw.close());
  assert.throws(() => validateOriginalAssets([], [f.manifest]), /缺少/);
  await assert.rejects(
    nativeBoardPackage(
      f.manifest,
      f.originals,
      async () => new Uint8Array([1]),
      hash,
    ),
    /校验/,
  );
  const bytes = await nativeBoardPackage(f.manifest, f.originals, f.read, hash);
  const files = readArchive(bytes, 96 * 1024 * 1024, 8192);
  files["learnstuff.graph.json"] = strToU8("{}");
  await assert.rejects(parseBoardPackage(writeArchive(files), hash), /哈希/);
});
test("v6 backup writes and verifies originals before committing the A/B completion pointer, failed original preserves previous pointer", async (t) => {
  const f = await packedFixture();
  t.after(() => f.raw.close());
  const snapshot: LocalBackupSnapshot = {
    format: "learnstuff-app-backup",
    version: 6,
    exportedAt: "2026-10-26",
    revision: 2,
    projects: [f.manifest],
    originalAssets: f.originals,
    answers: [],
    promptTemplates: [],
    topics: [],
    aiUnderstandingDocuments: [],
    projectAiScopeSettings: [],
    favorites: [],
    favoriteBindings: [],
    exclusions: [],
    knowledgeLibrary: f.manifest.knowledgeLibrary,
  };
  assert.equal(
    parseLocalBackupSnapshot(JSON.stringify(snapshot)).originalAssets?.length,
    2,
  );
  const writes: string[] = [];
  const store: BackupFileStore = {
    write: async (name) => {
      writes.push(name);
    },
    directory: async () => store,
    writeBytes: async (name, _mime, bytes) => {
      assert.equal(name, (await hash(bytes)) + ".bin");
      writes.push(name);
    },
  };
  await writeLocalBackupSnapshot(store, snapshot, "a", undefined, f.read);
  const marker = writes.indexOf("learnstuff-backup-commit-a.json");
  assert.equal(
    writes.slice(0, 2).every((name) => name.endsWith(".bin")),
    true,
  );
  assert.ok(marker > 1);
  assert.equal(writes.at(-1), "learnstuff-backup-latest.json");
  writes.length = 0;
  await assert.rejects(
    writeLocalBackupSnapshot(store, snapshot, "b", undefined, async () => {
      throw Error("synthetic storage failure");
    }),
    /failure/,
  );
  assert.equal(writes.includes("learnstuff-backup-latest.json"), false);
});
test("legacy graph-only import cannot create rich documents without their verified originals", async (t) => {
  const f = await packedFixture();
  t.after(() => f.raw.close());
  const before = f.raw.prepare("SELECT COUNT(*) AS n FROM projects").get();
  await assert.rejects(
    importPortableManifestWithMapping(f.db, f.manifest),
    /原件/,
  );
  assert.deepEqual(
    f.raw.prepare("SELECT COUNT(*) AS n FROM projects").get(),
    before,
  );
});
test("desktop empty nodes, unlabeled relations and orphaned old PDF retain a readable original in Android", async () => {
  const now = "2026-10-26";
  const files: Record<string, Uint8Array> = {
    "board.json": strToU8(
      JSON.stringify({
        version: 1,
        id: "board",
        projectId: "desktop",
        name: "Empty",
        created_at: now,
        updated_at: now,
        nodes: [
          { id: "n1", title: "一", summary: "", x: 0, y: 0, docs: [] },
          { id: "n2", title: "二", summary: "", x: 300, y: 0, docs: [] },
        ],
        edges: [{ id: "e", from: "n1", to: "n2", directed: true, label: null }],
      }),
    ),
    "docs/old.pdf": pdf,
  };
  files["lumen.package.json"] = strToU8(
    JSON.stringify({
      schema: "lumen.board-package/v1",
      files: Object.fromEntries(
        await Promise.all(
          Object.entries(files).map(async ([p, b]) => [p, await hash(b)]),
        ),
      ),
    }),
  );
  const parsed = await parseBoardPackage(writeArchive(files), hash);
  assert.equal(parsed.manifest.nodes.length, 2);
  assert.equal(parsed.manifest.edges.length, 1);
  assert.equal(parsed.originals.length, 1);
  assert.deepEqual(parsed.files[`assets/${await hash(pdf)}.bin`], pdf);
});
test("saved conversation links remap all message IDs, preserve prose and use separate desktop project/board scopes", async (t) => {
  const f = await packedFixture();
  t.after(() => f.raw.close());
  const conversation = await createConversation(
    f.db,
    f.board.projectId,
    f.board.nodeId,
    "来源",
  );
  const now = "2026-10-26";
  for (const [id, role, ordinal] of [
    ["question", "user", 0],
    ["answer", "assistant", 1],
  ] as const)
    f.raw
      .prepare("INSERT INTO conversation_messages VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        conversation,
        role,
        "原始问答",
        "complete",
        ordinal,
        null,
        null,
        now,
        now,
      );
  const raw = f.raw
    .prepare("SELECT body FROM documents WHERE id=?")
    .get(f.documentId) as any;
  const body =
    raw.body +
    `\n\n普通文字 question answer\n\n[返回](lumen://conversation/${conversation}?messages=question%2Canswer&project=${f.board.projectId}&board=${f.board.projectId})`;
  f.raw
    .prepare("UPDATE documents SET body=? WHERE id=?")
    .run(body, f.documentId);
  const manifest = await createPortableManifest(f.db, f.board.projectId);
  const uris = new Map(
    f.originals.map((ref) => [
      ref.sourceId,
      `file:///private/sync-blobs/${ref.sha256}`,
    ]),
  );
  const copy = await importPortableManifestWithMapping(f.db, manifest, uris);
  const copied = await createPortableManifest(f.db, copy.projectId);
  const doc = copied.documents.find((d) =>
    documentText(d.body).includes("普通文字"),
  )!;
  assert.match(doc.body, /普通文字 question answer/);
  assert.doesNotMatch(doc.body, /messages=question/);
  assert.match(
    doc.body,
    new RegExp(`project=${copy.projectId}&board=${copy.projectId}`),
  );
  const desktop = readArchive(
    await lumenBoardPackage(manifest, f.originals, f.read, hash),
    96 * 1024 * 1024,
    8192,
  );
  assert.ok(
    Object.entries(desktop).some(
      ([p, b]) =>
        p.endsWith(".md") &&
        strFromU8(b).includes(`project=android&board=${f.board.projectId}`),
    ),
  );
});
test("v6 restored backup attaches original bytes to new identities; omitted original prevents any copy", async (t) => {
  const f = await packedFixture();
  t.after(() => f.raw.close());
  const snapshot: LocalBackupSnapshot = {
    format: "learnstuff-app-backup",
    version: 6,
    exportedAt: "2026-10-26",
    revision: 1,
    projects: [f.manifest],
    originalAssets: f.originals,
    answers: [],
    promptTemplates: [],
    topics: [],
    aiUnderstandingDocuments: [],
    projectAiScopeSettings: [],
    favorites: [],
    favoriteBindings: [],
    knowledgeLibrary: f.manifest.knowledgeLibrary,
    exclusions: [],
  };
  const before = f.raw.prepare("SELECT COUNT(*) AS n FROM projects").get();
  await assert.rejects(importLocalBackupAsCopies(f.db, snapshot), /原件/);
  assert.deepEqual(
    f.raw.prepare("SELECT COUNT(*) AS n FROM projects").get(),
    before,
  );
  const uris = new Map(
    f.originals.map((ref) => [
      `${ref.projectId}/${ref.sourceId}`,
      `file:///private/sync-blobs/${ref.sha256}`,
    ]),
  );
  const restored = await importLocalBackupAsCopies(
    f.db,
    snapshot,
    undefined,
    uris,
  );
  const rows = f.raw
    .prepare("SELECT asset_uri FROM source_items WHERE project_id=?")
    .all(restored.projectIds[0]) as any[];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.asset_uri.includes("/sync-blobs/")));
  assert.deepEqual(f.raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("UTF-8 rejects malformed replacement and detached rich metadata; page segments hash actual text", async (t) => {
  assert.throws(() => plainMarkdown(new Uint8Array([0xc0, 0x80])), /UTF-8/);
  const f = await fixture();
  t.after(() => f.raw.close());
  const p = await prepareRichDocument("p.pdf", pdf, hash, [
    { page: 1, text: "page one" },
    { page: 2, text: "page two" },
  ]);
  assert.throws(() => plainMarkdown(strToU8(p.body)), /完整白板/);
  await attachRichDocument(
    f.db,
    f.board.projectId,
    f.board.nodeId,
    p,
    new Map([
      [
        p.metadata.original.sha256,
        `file:///private/sync-blobs/${p.metadata.original.sha256}`,
      ],
    ]),
  );
  const rows = f.raw
    .prepare("SELECT body,content_hash FROM source_segments ORDER BY ordinal")
    .all() as any[];
  for (const row of rows)
    assert.equal(row.content_hash, await hash(strToU8(row.body)));
});

test('portable Markdown preserves whitespace-only original document bytes',async t=>{const f=await fixture();t.after(()=>f.raw.close());const original=await createPortableManifest(f.db,f.board.projectId);const manifest={...original,documents:original.documents.map(d=>({...d,body:'\n\n'}))};const copied=await importPortableManifestWithMapping(f.db,manifest);assert.ok((await createPortableManifest(f.db,copied.projectId)).documents.some(d=>d.body==='\n\n'));});
