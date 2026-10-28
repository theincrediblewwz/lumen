/** Remap only typed application links. Ordinary prose containing an ID stays unchanged. */
export function remapFormalLinks(
  body: string,
  ids: Map<string, string>,
  projectId: string,
  groupId = projectId,
) {
  return body
    .replace(
      /lumen:\/\/conversation\/([^\s)>"'\]]+)/g,
      (whole, tail: string) => {
        const [old, query = ""] = tail.split("?"),
          next = ids.get(old);
        if (!next) return whole;
        const params = query
          .split("&")
          .filter(Boolean)
          .map((part) => {
            const i = part.indexOf("="),
              key = i < 0 ? part : part.slice(0, i),
              value = i < 0 ? "" : part.slice(i + 1);
            if (key === "project" || key === "board")
              return `${key}=${key === "project" ? groupId : projectId}`;
            if (key === "messages") {
              const decoded = value.replace(/%2C/gi, ",");
              return `messages=${decoded
                .split(",")
                .map((id) => ids.get(id) ?? id)
                .join(",")}`;
            }
            return part;
          });
        return `lumen://conversation/${next}${params.length ? "?" + params.join("&") : ""}`;
      },
    )
    .replace(/\[\[node:([A-Za-z0-9_-]+)\]\]/g, (whole, id: string) =>
      ids.has(id) ? `[[node:${ids.get(id)}]]` : whole,
    );
}
