import { remapFormalLinks } from "./formal-links";
import {
  readArchive,
  writeArchive,
  strFromU8,
  strToU8,
  type Digest,
} from "./rich-archive";
import {
  documentAssets,
  splitDocument,
  type DocumentAsset,
} from "./rich-document";
import {
  validatePortableManifest,
  type PortableGraphManifest,
} from "./portable-knowledge";
import { emptyKnowledgeLibrary } from "./knowledge-library-core";
import { validateOriginalAssets, type OriginalAsset } from "./rich-backup";
const LIMIT = 96 * 1024 * 1024;
const json = (value: unknown) => strToU8(JSON.stringify(value));
export type BoardPackage = {
  manifest: PortableGraphManifest;
  originals: OriginalAsset[];
  files: Record<string, Uint8Array>;
};
async function sealed(
  files: Record<string, Uint8Array>,
  schema: string,
  hash: Digest,
) {
  if (
    Object.values(files).reduce((n, b) => n + b.length, 0) >
    LIMIT - 2 * 1024 * 1024
  )
    throw Error("白板资料包超过96MiB处理预算");
  const name =
    schema === "lumen.board-package/v1"
      ? "lumen.package.json"
      : "learnstuff.package.json";
  files[name] = json({
    schema,
    files: Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([p, b]) => [p, await hash(b)]),
      ),
    ),
  });
  return writeArchive(files);
}
export async function nativeBoardPackage(
  manifest: PortableGraphManifest,
  originals: OriginalAsset[],
  read: (ref: OriginalAsset) => Promise<Uint8Array>,
  hash: Digest,
) {
  validatePortableManifest(manifest);
  validateOriginalAssets(originals, [manifest]);
  const files: Record<string, Uint8Array> = {
    "learnstuff.graph.json": json(manifest),
    "originals.json": json(originals),
  };
  for (const ref of originals) {
    const bytes = await read(ref);
    if (bytes.length !== ref.size || (await hash(bytes)) !== ref.sha256)
      throw Error("原件校验失败，未导出");
    files[`assets/${ref.sha256}.bin`] = bytes;
  }
  return sealed(files, "learnstuff.board-package/v1", hash);
}
export async function parseBoardPackage(
  bytes: Uint8Array,
  hash: Digest,
): Promise<BoardPackage> {
  const files = readArchive(bytes, LIMIT, 8192),
    seal = files["learnstuff.package.json"]
      ? "learnstuff.package.json"
      : "lumen.package.json";
  if (!files[seal]) throw Error("这不是白板资料包；图文ZIP请在节点中导入");
  const descriptor = JSON.parse(strFromU8(files[seal]));
  const native = descriptor.schema === "learnstuff.board-package/v1";
  if (!native && descriptor.schema !== "lumen.board-package/v1")
    throw Error("不支持的白板资料包版本");
  if (
    !descriptor.files ||
    typeof descriptor.files !== "object" ||
    Array.isArray(descriptor.files) ||
    Object.keys(descriptor.files).length !== Object.keys(files).length - 1
  )
    throw Error("资料包清单不完整");
  for (const [p, b] of Object.entries(files))
    if (p !== seal && descriptor.files[p] !== (await hash(b)))
      throw Error("资料包文件哈希不符，尚未导入");
  if (native) {
    if (
      Object.keys(files).some(
        (p) =>
          ![
            "learnstuff.package.json",
            "learnstuff.graph.json",
            "originals.json",
          ].includes(p) && !/^assets\/[a-f0-9]{64}\.bin$/.test(p),
      )
    )
      throw Error("资料包含未知文件");
    const manifest = validatePortableManifest(
      JSON.parse(strFromU8(files["learnstuff.graph.json"])),
    );
    const originals = validateOriginalAssets(
      JSON.parse(strFromU8(files["originals.json"])),
      [manifest],
    );
    for (const ref of originals) {
      const b = files[`assets/${ref.sha256}.bin`];
      if (!b || b.length !== ref.size || (await hash(b)) !== ref.sha256)
        throw Error("白板资料包缺少原件");
    }
    return { manifest, originals, files };
  }
  if (
    Object.keys(files).some(
      (p) =>
        ![
          "lumen.package.json",
          "board.json",
          "chats.json",
          "chat-captures.json",
          "reading-positions.json",
          "knowledge.json",
        ].includes(p) && !p.startsWith("docs/"),
    )
  )
    throw Error("资料包含未知文件");
  return fromLumen(files, hash);
}
async function fromLumen(
  files: Record<string, Uint8Array>,
  hash: Digest,
): Promise<BoardPackage> {
  if (!files["board.json"]) throw Error("缺少白板结构");
  const board = JSON.parse(strFromU8(files["board.json"]));
  if (
    board.version !== 1 ||
    !Array.isArray(board.nodes) ||
    !Array.isArray(board.edges)
  )
    throw Error("白板结构无效");
  const now = board.updated_at ?? new Date().toISOString(),
    documents: any[] = [],
    docPaths = new Map<string, string>();
  function doc(path: string, title: string, body: string) {
    if (docPaths.has(path)) return docPaths.get(path)!;
    const id = `document_${documents.length}`;
    docPaths.set(path, id);
    documents.push({
      id,
      path,
      title,
      body,
      origin: "source",
      createdAt: board.created_at ?? now,
      updatedAt: now,
    });
    return id;
  }
  for (const [path, bytes] of Object.entries(files))
    if (path.startsWith("docs/") && /\.(md|markdown)$/i.test(path)) {
      const title =
        board.nodes
          .flatMap((n: any) => n.docs ?? [])
          .find((d: any) => d.path === path)?.title ?? path.split("/").pop();
      doc(path, title, strFromU8(bytes));
    }
  const refs = new Map<string, { ref: DocumentAsset; docId: string }>();
  for (const d of documents)
    for (const ref of documentAssets(d.body)) {
      const content = files[ref.path];
      if (
        !content ||
        content.length !== ref.size ||
        (await hash(content)) !== ref.sha256
      )
        throw Error("白板缺少图片或PDF原件");
      refs.set(ref.sha256, { ref, docId: d.id });
    }
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith("docs/") || /\.(md|markdown)$/i.test(path)) continue;
    const sha256 = await hash(content);
    if (refs.has(sha256)) continue;
    const ext = path.split(".").pop()?.toLowerCase(),
      media_type =
        (
          {
            pdf: "application/pdf",
            zip: "application/zip",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
          } as Record<string, string>
        )[ext ?? ""] ?? "application/octet-stream";
    const docId = doc(
      `docs/original_note_${refs.size}.md`,
      path.split("/").pop()!,
      `# 原件\n\n原始文件 ${path} 已保留。`,
    );
    refs.set(sha256, {
      ref: { path, sha256, size: content.length, media_type },
      docId,
    });
  }
  const sourceItems: any[] = [],
    originals: OriginalAsset[] = [];
  for (const { ref, docId } of refs.values()) {
    const id = `source_${sourceItems.length}`;
    sourceItems.push({
      id,
      kind:
        ref.media_type === "application/pdf"
          ? "pdf"
          : ref.media_type.startsWith("image/")
            ? "image"
            : "markdown",
      title: ref.path.split("/").pop(),
      originalName: ref.path.split("/").pop(),
      mediaType: ref.media_type,
      sourceUrl: null,
      contentHash: ref.sha256,
      byteSize: ref.size,
      extractionStatus: "ready",
      extractionError: null,
      originalAssetIncluded: false,
      derivedDocumentId: docId,
      createdAt: now,
      updatedAt: now,
      segments: documentAssets(documents.find((d) => d.id === docId)!.body)
        .length
        ? []
        : [
            {
              ordinal: 0,
              locatorType: "text",
              locator: "原件",
              body: "原件已保留，尚未提取可供AI阅读的文字。",
              contentHash: ref.sha256,
            },
          ],
    });
    originals.push({
      projectId: board.id,
      sourceId: id,
      sha256: ref.sha256,
      size: ref.size,
      mediaType: ref.media_type,
    });
    files[`assets/${ref.sha256}.bin`] = files[ref.path];
  }
  const nodeDocuments: any[] = [];
  const nodes = board.nodes.map((node: any, index: number) => {
    const mounted = (node.docs ?? []).map((ref: any, rank: number) => {
      const id = docPaths.get(ref.path);
      if (!id) throw Error("节点挂载文档缺失");
      nodeDocuments.push({
        id: `link_${index}_${rank}`,
        node_id: node.id,
        document_id: id,
        sort_order: rank,
      });
      return id;
    });
    const primary =
      mounted[0] ??
      doc(
        `docs/empty_${node.id}.md`,
        node.title,
        node.summary || `# ${node.title}`,
      );
    if (!mounted.length)
      nodeDocuments.push({
        id: `link_${index}`,
        node_id: node.id,
        document_id: primary,
        sort_order: 0,
      });
    return {
      id: node.id,
      title: node.title,
      subtitle: node.summary ?? "",
      x: node.x,
      y: node.y,
      importance: 5,
      status: "learning",
      order: index,
      documentId: primary,
    };
  });
  const edges = board.edges.map((e: any) => ({
    id: e.id,
    sourceId: e.from,
    targetId: e.to,
    relation: "support",
    importance: 5,
    documentId: doc(
      `docs/edge_${e.id}.md`,
      e.label || "关系",
      e.label || "# 关系",
    ),
    reviewStatus: "unverified",
    reviewedAt: null,
  }));
  const chats = files["chats.json"]
    ? JSON.parse(strFromU8(files["chats.json"]))
    : { version: 1, conversations: [] };
  if (chats.version !== 1 || !Array.isArray(chats.conversations))
    throw Error("原始对话格式无效");
  const conversations: any[] = [],
    messages: any[] = [];
  for (const c of chats.conversations) {
    conversations.push({
      id: c.id,
      node_id: c.sourceNodeId ?? null,
      title: c.title ?? "对话",
      created_at: c.createdAt ?? now,
      updated_at: c.updatedAt ?? now,
    });
    for (const [mIndex, m] of (c.messages ?? []).entries())
      messages.push({
        id: m.id ?? `${c.id}_message_${mIndex}`,
        conversation_id: c.id,
        role: m.role,
        body: m.content,
        status: m.error ? "failed" : "complete",
        ordinal: mIndex,
        request_id: null,
        actual_model: null,
        created_at: m.at ?? now,
        updated_at: m.at ?? now,
      });
  }
  const captures = files["chat-captures.json"]
    ? JSON.parse(strFromU8(files["chat-captures.json"]))
    : [];
  const positions = files["reading-positions.json"]
    ? JSON.parse(strFromU8(files["reading-positions.json"]))
    : [];
  const manifest = validatePortableManifest({
    format: "learnstuff-graph",
    version: 5,
    exportedAt: now,
    project: {
      id: board.id,
      title: board.name,
      sourceText: "",
      createdAt: board.created_at ?? now,
      updatedAt: now,
      layoutDirection: "vertical",
    },
    documents,
    nodes,
    edges,
    savedAnswers: [],
    sourceItems,
    knowledgeLibrary: files["knowledge.json"]
      ? JSON.parse(strFromU8(files["knowledge.json"]))
      : emptyKnowledgeLibrary(),
    fusion: {
      graphKind: "free",
      nodeDocuments,
      conversations,
      messages,
      conversationDocuments: captures.map((c: any) => ({
        id: c.id,
        conversation_id: c.conversation_id ?? null,
        source_answer_id: null,
        document_id: docPaths.get(c.document_path),
        node_id: c.node_id ?? null,
        message_ids_json: c.message_ids_json ?? "[]",
        selection_key: c.selection_key ?? `import:${c.id}`,
        created_at: c.created_at ?? now,
      })),
      readingPositions: positions.map((p: any, index: number) => ({
        id: `position_${index}`,
        document_id: docPaths.get(p.path),
        anchor: p.anchor ?? "",
        ratio: p.ratio ?? 0,
        updated_at: p.updated_at ?? now,
      })),
      edgePresentation: board.edges.map((e: any) => ({
        id: e.id,
        relation_kind: "related",
        directed: e.directed ? 1 : 0,
        label: e.label ?? "",
      })),
    },
  });
  validateOriginalAssets(originals, [manifest]);
  return { manifest, originals, files };
}
/** Desktop-compatible common model. Android's full archive remains the lossless format. */
export async function lumenBoardPackage(
  manifest: PortableGraphManifest,
  originals: OriginalAsset[],
  read: (ref: OriginalAsset) => Promise<Uint8Array>,
  hash: Digest,
) {
  validatePortableManifest(manifest);
  validateOriginalAssets(originals, [manifest]);
  const paths = new Map(
    manifest.documents.map((d, i) => [d.id, `docs/document_${i}.md`]),
  );
  const docs = new Map(manifest.documents.map((d) => [d.id, d]));
  const files: Record<string, Uint8Array> = {};
  const conversationIds = new Map(
    (manifest.fusion?.conversations ?? []).map((c) => [c.id, c.id]),
  );
  const forDesktop = (body: string) =>
    remapFormalLinks(body, conversationIds, manifest.project.id, "android");
  for (const doc of manifest.documents)
    files[paths.get(doc.id)!] = strToU8(forDesktop(doc.body));
  for (const ref of originals) {
    const bytes = await read(ref);
    if ((await hash(bytes)) !== ref.sha256 || bytes.length !== ref.size)
      throw Error("原件校验失败");
    const required = manifest.documents
      .flatMap((d) => documentAssets(d.body))
      .find((asset) => asset.sha256 === ref.sha256);
    if (required) files[required.path] = bytes;
    else {
      const ext =
        ref.mediaType === "application/pdf"
          ? "pdf"
          : ref.mediaType === "image/png"
            ? "png"
            : ref.mediaType === "image/jpeg"
              ? "jpg"
              : "bin";
      files[`docs/asset_${ref.sha256}.${ext}`] = bytes;
    }
  }
  const nodes = manifest.nodes.map((n) => {
    const ids = [
      n.documentId,
      ...(manifest.fusion?.nodeDocuments ?? [])
        .filter((l) => l.node_id === n.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((l) => l.document_id),
    ];
    return {
      id: n.id,
      title: n.title,
      summary: n.subtitle,
      x: n.x,
      y: n.y,
      w: 240,
      docs: [...new Set(ids)].map((id) => ({
        path: paths.get(id)!,
        title: docs.get(id)!.title,
        bytes: strToU8(docs.get(id)!.body).length,
      })),
      created_at: manifest.project.createdAt,
      updated_at: manifest.project.updatedAt,
    };
  });
  files["board.json"] = json({
    version: 1,
    id: manifest.project.id,
    projectId: "android",
    name: manifest.project.title,
    created_at: manifest.project.createdAt,
    updated_at: manifest.project.updatedAt,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: manifest.edges.map((e) => {
      const style = manifest.fusion?.edgePresentation.find(
        (r) => r.id === e.id,
      );
      return {
        id: e.id,
        from: e.sourceId,
        to: e.targetId,
        directed: style?.directed !== 0,
        label: style?.label ?? e.relation,
        created_at: manifest.project.createdAt,
      };
    }),
  });
  files["chats.json"] = json({
    version: 1,
    conversations: (manifest.fusion?.conversations ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      sourceNodeId: c.node_id ?? undefined,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      messages: (manifest.fusion?.messages ?? [])
        .filter((m) => m.conversation_id === c.id)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: forDesktop(m.body),
          error: m.status === "failed",
          at: m.created_at,
        })),
    })),
  });
  files["chat-captures.json"] = json(
    (manifest.fusion?.conversationDocuments ?? []).map((c) => ({
      ...c,
      source_answer_id: null,
      document_path: paths.get(c.document_id),
    })),
  );
  files["reading-positions.json"] = json(
    (manifest.fusion?.readingPositions ?? []).map((p) => ({
      ...p,
      path: paths.get(p.document_id),
    })),
  );
  files["knowledge.json"] = json(
    manifest.knowledgeLibrary ?? emptyKnowledgeLibrary(),
  );
  return sealed(files, "lumen.board-package/v1", hash);
}
