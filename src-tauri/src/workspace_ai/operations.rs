use crate::project_canvas::Position;
use serde::{Deserialize, Deserializer};

pub(super) const SCHEMA: &str = "lumen.workspace-operations/v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Batch {
    pub schema: String,
    pub operations: Vec<Operation>,
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Operation {
    CreateProject {
        key: String,
        name: String,
        parent_id: Option<String>,
        position: Option<Position>,
    },
    RenameProject {
        project_id: String,
        name: String,
    },
    MoveProject {
        project_id: String,
        #[serde(deserialize_with = "present_nullable")]
        parent_id: Option<String>,
        position: Option<Position>,
    },
    RemoveProject {
        project_id: String,
        #[serde(default)]
        include_children: bool,
    },
    ProjectLink {
        from: String,
        to: String,
        label: Option<String>,
        #[serde(default)]
        remove: bool,
    },
    CreateBoard {
        key: String,
        project_id: String,
        name: String,
        position: Option<Position>,
    },
    UpdateBoard {
        board: BoardRef,
        name: Option<String>,
        position: Option<Position>,
        appearance: Option<Appearance>,
    },
    RemoveBoard {
        board: BoardRef,
    },
    CreateNode {
        key: String,
        board: BoardRef,
        fields: NodeFields,
    },
    UpdateNode {
        board: BoardRef,
        node_id: String,
        fields: NodeFields,
    },
    RemoveNode {
        board: BoardRef,
        node_id: String,
        #[serde(default)]
        include_flow: bool,
    },
    ConnectNodes {
        key: Option<String>,
        board: BoardRef,
        from: String,
        to: String,
        directed: Option<bool>,
        label: Option<String>,
        route: Option<Route>,
    },
    UpdateEdge {
        board: BoardRef,
        edge_id: String,
        directed: Option<bool>,
        label: Option<String>,
        route: Option<Route>,
    },
    RemoveEdge {
        board: BoardRef,
        edge_id: String,
    },
    SetFlow {
        board: BoardRef,
        owner_id: String,
        step_ids: Vec<String>,
    },
    ArrangeNodes {
        board: BoardRef,
        node_ids: Option<Vec<String>>,
        direction: LayoutDirection,
        spacing: LayoutSpacing,
        reason: String,
    },
    AddMarkdown {
        board: BoardRef,
        node_id: String,
        title: String,
        markdown: String,
    },
    EditMarkdown {
        board: BoardRef,
        node_id: String,
        document_id: String,
        revision: String,
        markdown: String,
    },
    RenameDocument {
        board: BoardRef,
        node_id: String,
        document_id: String,
        title: String,
    },
    AttachDocument {
        board: BoardRef,
        source_board: Option<BoardRef>,
        from_node_id: String,
        document_id: String,
        to_node_id: String,
    },
    DetachDocument {
        board: BoardRef,
        node_id: String,
        document_id: String,
    },
    ReorderDocuments {
        board: BoardRef,
        node_id: String,
        document_ids: Vec<String>,
    },
    SetCover {
        target: Target,
        #[serde(deserialize_with = "present_nullable")]
        cover_id: Option<String>,
    },
    SetPinned {
        target: Target,
        pinned: bool,
    },
    CreateTag {
        key: String,
        name: String,
        color: String,
    },
    EditTag {
        tag_id: String,
        name: Option<String>,
        color: Option<String>,
    },
    RemoveTag {
        tag_id: String,
    },
    AssignTags {
        target: Target,
        #[serde(default)]
        add: Vec<String>,
        #[serde(default)]
        remove: Vec<String>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BoardRef {
    pub project_id: String,
    pub board_id: String,
}

#[derive(Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum LayoutDirection {
    Down,
    Right,
}

#[derive(Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum LayoutSpacing {
    Compact,
    Balanced,
    Airy,
}

fn present_nullable<'de, D: Deserializer<'de>>(input: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(input)
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Target {
    Project { project_id: String },
    Board { board: BoardRef },
    Node { board: BoardRef, node_id: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NodeFields {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub position: Option<Position>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub color: Option<String>,
}

#[derive(Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Font {
    System,
    Serif,
    Sans,
    Mono,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Appearance {
    pub font_family: Option<Font>,
    pub font_size: Option<f64>,
    pub preview_font_family: Option<Font>,
    pub preview_font_size: Option<f64>,
    pub zoom_sensitivity: Option<f64>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum Route {
    Auto,
    Straight,
    Bent { control: Option<Position> },
}
