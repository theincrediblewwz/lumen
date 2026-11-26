//! Shared validation and reserved geometry for measured layouts.
use crate::{project_canvas::Position, storage::{BoardFile, BoardNode}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Bounds {
    pub(crate) fn union(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Self {
            x,
            y,
            w: (self.x + self.w).max(other.x + other.w) - x,
            h: (self.y + self.h).max(other.y + other.h) - y,
        }
    }

    pub(crate) fn reserved(node: &BoardNode) -> Self {
        let w = node
            .docs
            .first()
            .and_then(|doc| doc.image_display.as_ref())
            .map_or(node.w, |image| image.width)
            .max(node.w);
        let has_body = node
            .summary
            .as_ref()
            .is_some_and(|summary| !summary.trim().is_empty());
        let has_attachment = node
            .docs
            .iter()
            .any(|doc| !doc.path.starts_with("docs/question_"));
        let default_height = 80.0
            + 320.0 * (u8::from(has_body) + u8::from(has_attachment)) as f64
            + 48.0 * (node.title.chars().count().div_ceil(16)) as f64;
        Self {
            x: node.x,
            y: node.y,
            w,
            h: node
                .extra
                .get("h")
                .and_then(Value::as_f64)
                .unwrap_or(default_height),
        }
    }

    pub(crate) fn check(self) -> Result<(), String> {
        Position {
            x: self.x,
            y: self.y,
        }
        .check()?;
        if ![self.w, self.h]
            .iter()
            .all(|value| (1.0..=32768.0).contains(value))
        {
            return Err("节点的测量尺寸超出布局范围".into());
        }
        Ok(())
    }

    pub(crate) fn overlaps(self, other: Self) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
}

pub(crate) fn node_color(value: String) -> Result<Option<String>, String> {
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() != 7 || !value.starts_with('#') || !value.bytes().skip(1).all(|c| c.is_ascii_hexdigit()) {
        return Err("节点颜色需要是 #RRGGBB，空字符串使用默认颜色".into());
    }
    Ok(Some(value))
}

/// A bend is stored in board coordinates. Keep its offset from the moving endpoints.
pub(crate) fn translate_bends(board: &mut BoardFile, before: &BTreeMap<String, Position>) -> Result<(), String> {
    let shifts: BTreeMap<_, _> = board.nodes.iter().filter_map(|node| {
        before.get(&node.id).map(|old| (node.id.as_str(), (node.x - old.x, node.y - old.y)))
    }).collect();
    for edge in &mut board.edges {
        let from = shifts.get(edge.from.as_str()).copied().unwrap_or_default();
        let to = shifts.get(edge.to.as_str()).copied().unwrap_or_default();
        let (dx, dy) = ((from.0 + to.0) / 2.0, (from.1 + to.1) / 2.0);
        if dx == 0.0 && dy == 0.0 { continue; }
        let Some(route) = edge.extra.get_mut("route").filter(|route| route["kind"] == "bent") else { continue };
        let (Some(x), Some(y)) = (route["control"]["x"].as_f64(), route["control"]["y"].as_f64()) else { continue };
        let at = Position { x: x + dx, y: y + dy };
        at.check()?;
        route["control"] = serde_json::to_value(at).map_err(|error| error.to_string())?;
    }
    Ok(())
}
