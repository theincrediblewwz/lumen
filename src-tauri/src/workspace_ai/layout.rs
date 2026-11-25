use super::{check_revisions, draft::board_path, operations::*, Prepared, MAX_CHANGE_BYTES};
use crate::{
    project_canvas::Position,
    storage::{BoardEdge, BoardFile, BoardNode},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Bounds {
    pub(super) fn union(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Self {
            x,
            y,
            w: (self.x + self.w).max(other.x + other.w) - x,
            h: (self.y + self.h).max(other.y + other.h) - y,
        }
    }

    pub(super) fn reserved(node: &BoardNode) -> Self {
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

    fn check(self) -> Result<(), String> {
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

    fn overlaps(self, other: Self) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SourceBoard {
    pub project_id: String,
    pub board_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PreviewDocument {
    pub markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceBoard>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LayoutJob {
    pub project_id: String,
    pub board_id: String,
    pub name: String,
    pub nodes: Vec<BoardNode>,
    pub edges: Vec<BoardEdge>,
    pub appearance: Option<Value>,
    pub reserved: Option<Bounds>,
    pub direction: LayoutDirection,
    pub spacing: LayoutSpacing,
    pub reason: String,
    pub documents: BTreeMap<String, PreviewDocument>,
}

impl LayoutJob {
    pub(super) fn path(&self) -> String {
        board_path(&(self.project_id.clone(), self.board_id.clone()))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasuredLayout {
    project_id: String,
    board_id: String,
    nodes: BTreeMap<String, Bounds>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LayoutPreview {
    project_id: String,
    board_id: String,
    name: String,
    direction: LayoutDirection,
    spacing: LayoutSpacing,
    reason: String,
    nodes: Vec<PreviewNode>,
    edges: Vec<BoardEdge>,
}

#[derive(Clone, Serialize)]
struct PreviewNode {
    id: String,
    title: String,
    color: Option<String>,
    #[serde(flatten)]
    bounds: Bounds,
}

impl LayoutJob {
    fn validate(&self, measured: &MeasuredLayout) -> Result<(), String> {
        if self.nodes.len() != measured.nodes.len()
            || self
                .nodes
                .iter()
                .any(|node| !measured.nodes.contains_key(&node.id))
        {
            return Err("布局测量结果和预览节点不一致".into());
        }
        let mut placed = Vec::<Bounds>::new();
        for rect in measured.nodes.values().copied() {
            rect.check()?;
            if placed.iter().any(|other| rect.overlaps(*other))
                || self
                    .reserved
                    .is_some_and(|reserved| rect.overlaps(reserved))
            {
                return Err("布局结果仍有节点重叠，请调整间距后重试".into());
            }
            placed.push(rect);
        }
        Ok(())
    }
}

/// Accept geometry for exactly the staged targets. The ordinary apply/undo
/// transaction still owns all writes and captures the original board bytes.
pub(super) fn place(
    root: &Path,
    prepared: &mut Prepared,
    layouts: Vec<MeasuredLayout>,
) -> Result<(), String> {
    let jobs = &prepared.plan.layout_jobs;
    if jobs.is_empty() || jobs.len() != layouts.len() {
        return Err("待测量的白板和布局结果不一致".into());
    }
    check_revisions(
        root,
        &prepared.observed,
        "测量期间白板或资料已修改，请重新生成方案",
    )?;
    let mut previews = Vec::new();
    let mut writes = BTreeMap::new();
    let mut measured_boards = BTreeSet::new();
    for measured in &layouts {
        let job = jobs
            .iter()
            .find(|job| job.project_id == measured.project_id && job.board_id == measured.board_id)
            .ok_or("布局不属于本次方案")?;
        let path = job.path();
        if !measured_boards.insert(path.clone()) {
            return Err("同一白板重复提交布局".into());
        }
        job.validate(measured)?;
        let mut board: BoardFile =
            serde_json::from_slice(prepared.files.get(&path).ok_or("待测量的白板未载入")?)
                .map_err(|error| error.to_string())?;
        for node in &mut board.nodes {
            if let Some(rect) = measured.nodes.get(&node.id) {
                node.x = rect.x;
                node.y = rect.y;
                node.w = rect.w;
                node.extra.insert("h".into(), json!(rect.h));
            }
        }
        writes.insert(path, super::encode(&board)?);
        previews.push(LayoutPreview {
            project_id: job.project_id.clone(),
            board_id: job.board_id.clone(),
            name: job.name.clone(),
            direction: job.direction,
            spacing: job.spacing,
            reason: job.reason.clone(),
            nodes: job
                .nodes
                .iter()
                .map(|node| PreviewNode {
                    id: node.id.clone(),
                    title: node.title.clone(),
                    color: node.color.clone(),
                    bounds: measured.nodes[&node.id],
                })
                .collect(),
            edges: job.edges.clone(),
        });
    }
    let bytes: usize = prepared
        .files
        .iter()
        .map(|(path, data)| {
            writes.get(path).unwrap_or(data).len()
                + prepared.before[path].as_ref().map_or(0, Vec::len)
        })
        .sum();
    if bytes > MAX_CHANGE_BYTES {
        return Err("测量后的方案超过事务容量，请分批整理".into());
    }
    prepared.files.extend(writes);
    prepared.plan.layouts = previews;
    prepared.plan.layout_jobs.clear();
    Ok(())
}
