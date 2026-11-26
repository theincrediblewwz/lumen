use super::*;
use crate::storage::{BoardEdge, BoardNode};
use serde_json::{json, Value};

impl Draft<'_> {
    pub(super) fn apply_canvas_or_resource(&mut self, op: Operation) -> Result<(), String> {
        match op {
            Operation::CreateNode {
                key: alias,
                board,
                fields,
            } => {
                let key = self.board_key(&board)?;
                let id = storage::new_id("n");
                self.alias(&alias, &id)?;
                let now = storage::now_iso();
                let state = &self.boards[&key];
                let count = state.board.nodes.len()
                    - state.original_nodes.len().min(state.board.nodes.len());
                let origin_y = state
                    .original_nodes
                    .iter()
                    .filter(|n| !n.extra.contains_key("flowOwnerId"))
                    .map(|n| n.y + n.extra.get("h").and_then(Value::as_f64).unwrap_or(140.0) + 96.0)
                    .fold(120.0, f64::max);
                let mut node = BoardNode {
                    id: id.clone(),
                    title: String::new(),
                    summary: None,
                    x: 120.0 + (count % 4) as f64 * 380.0,
                    y: origin_y + (count / 4) as f64 * 250.0,
                    w: 280.0,
                    color: None,
                    docs: vec![],
                    created_at: now.clone(),
                    updated_at: now,
                    extra: BTreeMap::new(),
                };
                let body = fields.summary.clone();
                update_node(&mut node, fields)?;
                let location = self.node_trail(&key, &node);
                self.board_mut(&key).nodes.push(node);
                self.check_nodes.insert((key, id));
                self.record("新建节点", location, None, body, false);
            }
            Operation::UpdateNode {
                board,
                node_id,
                fields,
            } => {
                let key = self.board_key(&board)?;
                let id = self.resolve(&node_id)?;
                let old = self.node(&key, &id)?;
                let location = self.node_trail(&key, old);
                let before = fields.summary.as_ref().and(old.summary.clone());
                let after = fields.summary.clone();
                let mut properties = Vec::new();
                if let Some(title) = &fields.title {
                    properties.push(format!("标题 → {title}"));
                }
                if let Some(p) = &fields.position {
                    properties.push(format!("位置 ({}, {})", p.x, p.y));
                }
                if let Some(w) = fields.width {
                    properties.push(format!("宽 {w}"));
                }
                if let Some(h) = fields.height {
                    properties.push(format!("高 {h}"));
                }
                if let Some(color) = &fields.color {
                    properties.push(if color.is_empty() {
                        "默认颜色".into()
                    } else {
                        format!("颜色 {color}")
                    });
                }
                let label = if properties.is_empty() {
                    location
                } else {
                    format!("{} · {}", location, properties.join(" · "))
                };
                update_node(self.node_mut(&key, &id)?, fields)?;
                self.check_nodes.insert((key, id));
                self.record("更新节点", label, before, after, false);
            }
            Operation::RemoveNode {
                board,
                node_id,
                include_flow,
            } => {
                let key = self.board_key(&board)?;
                let id = self.resolve(&node_id)?;
                let node = self.node(&key, &id)?;
                let location = self.node_trail(&key, node);
                let owner_id = flow_owner(node).map(str::to_owned);
                let steps = flow_members(&self.boards[&key].board, &id);
                if !steps.is_empty() && !include_flow {
                    return Err("节点包含子流程，需要明确设置 includeFlow 才能一起移除".into());
                }
                let count = steps.len();
                let mut removed: BTreeSet<_> = steps.into_iter().collect();
                removed.insert(id);
                let board = self.board_mut(&key);
                board.nodes.retain(|n| !removed.contains(&n.id));
                board
                    .edges
                    .retain(|e| !removed.contains(&e.from) && !removed.contains(&e.to));
                if let Some(owner) = owner_id {
                    let ids = flow_members(board, &owner);
                    set_flow(board, &owner, &ids)?;
                }
                for id in removed {
                    self.layout
                        .tags
                        .remove_tree(&format!("{}/{}/{id}", key.0, key.1));
                }
                self.layout_changed = true;
                self.record(
                    "移除节点",
                    format!("{location} · {count} 个子流程步骤"),
                    None,
                    None,
                    true,
                );
            }
            Operation::ConnectNodes {
                key: alias,
                board,
                from,
                to,
                directed,
                label,
                route,
            } => {
                let key = self.board_key(&board)?;
                let from = self.resolve(&from)?;
                let to = self.resolve(&to)?;
                let a = self.node(&key, &from)?;
                let b = self.node(&key, &to)?;
                if from == to {
                    return Err("连线两端需要是不同节点".into());
                }
                if flow_owner(a).is_some() || flow_owner(b).is_some() {
                    return Err("请用 set_flow 生成子流程内的相邻连线".into());
                }
                let location = format!("{} / {} → {}", self.board_trail(&key), a.title, b.title);
                let is_directed = directed.unwrap_or(true);
                let graph = &self.boards[&key].board;
                if graph.edges.iter().any(|edge| {
                    edge.from == from && edge.to == to
                        || (!edge.directed || !is_directed) && edge.from == to && edge.to == from
                }) {
                    return Err("连线已存在，请使用 update_edge".into());
                }
                let mut edge = new_edge(from, to);
                if let Some(alias) = alias {
                    self.alias(&alias, &edge.id)?;
                }
                let detail = edge_description(directed, &label, &route);
                update_edge(&mut edge, directed, label, route)?;
                self.board_mut(&key).edges.push(edge);
                self.record("建立节点连线", location, None, detail, false);
            }
            Operation::UpdateEdge {
                board,
                edge_id,
                directed,
                label,
                route,
            } => {
                let key = self.board_key(&board)?;
                let id = self.resolve(&edge_id)?;
                let location = self.edge_location(&key, &id)?;
                let detail = edge_description(directed, &label, &route);
                let graph = &self.boards[&key].board;
                let previous = edge(graph, &id)?;
                let in_flow = graph
                    .nodes
                    .iter()
                    .any(|n| n.id == previous.from && flow_owner(n).is_some());
                if in_flow && directed == Some(false) {
                    return Err("子流程连线保持有向".into());
                }
                if directed == Some(false)
                    && graph
                        .edges
                        .iter()
                        .any(|e| e.from == previous.to && e.to == previous.from)
                {
                    return Err("存在反向连线，无法改为一条无向线".into());
                }
                let previous_label = previous.label.clone();
                update_edge(edge_mut(self.board_mut(&key), &id)?, directed, label, route)?;
                self.record("更新节点连线", location, previous_label, detail, false);
            }
            Operation::RemoveEdge { board, edge_id } => {
                let key = self.board_key(&board)?;
                let id = self.resolve(&edge_id)?;
                let location = self.edge_location(&key, &id)?;
                let previous = edge(&self.boards[&key].board, &id)?;
                if flow_owner(self.node(&key, &previous.from)?).is_some() {
                    return Err("用 set_flow 调整子流程步骤，连线随顺序更新".into());
                }
                self.board_mut(&key).edges.retain(|edge| edge.id != id);
                self.record("移除节点连线", location, None, None, true);
            }
            Operation::SetFlow {
                board,
                owner_id,
                step_ids,
            } => {
                let key = self.board_key(&board)?;
                let owner = self.resolve(&owner_id)?;
                let ids = step_ids
                    .iter()
                    .map(|s| self.resolve(s))
                    .collect::<Result<Vec<_>, _>>()?;
                let location = self.node_trail(&key, self.node(&key, &owner)?);
                let before_ids = flow_members(&self.boards[&key].board, &owner);
                let describe = |steps: &[String]| -> Result<String, String> {
                    steps
                        .iter()
                        .enumerate()
                        .map(|(i, id)| {
                            let node = self.node(&key, id)?;
                            let name = if node.title.trim().is_empty() {
                                "无标题步骤"
                            } else {
                                &node.title
                            };
                            Ok(format!("{}. {name}", i + 1))
                        })
                        .collect::<Result<Vec<_>, _>>()
                        .map(|steps| steps.join("\n"))
                };
                let before = describe(&before_ids)?;
                let after = describe(&ids)?;
                set_flow(self.board_mut(&key), &owner, &ids)?;
                self.check_nodes.insert((key, owner));
                self.record("设置子流程顺序", location, Some(before), Some(after), false);
            }
            op => self.apply_resource(op)?,
        }
        Ok(())
    }

    pub(super) fn appearance(
        &mut self,
        key: &BoardKey,
        location: String,
        fields: Appearance,
    ) -> Result<(), String> {
        let board = self.board_mut(key);
        let current = board
            .extra
            .entry("appearance".into())
            .or_insert_with(|| json!({}));
        if !current.is_object() {
            *current = json!({});
        }
        let settings = current.as_object_mut().unwrap();
        let mut changes = Vec::new();
        for (key, label, font) in [
            ("fontFamily", "标题字体", fields.font_family),
            ("previewFontFamily", "预览字体", fields.preview_font_family),
        ] {
            if let Some(font) = font {
                let value = serde_json::to_value(font).map_err(|e| e.to_string())?;
                changes.push(format!("{label} {}", value.as_str().unwrap()));
                settings.insert(key.into(), value);
            }
        }
        for (key, label, value, low, high) in [
            ("fontSize", "标题字号", fields.font_size, 12.0, 32.0),
            (
                "previewFontSize",
                "预览字号",
                fields.preview_font_size,
                12.0,
                32.0,
            ),
            (
                "zoomSensitivity",
                "缩放灵敏度",
                fields.zoom_sensitivity,
                0.25,
                3.0,
            ),
        ] {
            if let Some(value) = value {
                range(value, low, high, label)?;
                changes.push(format!("{label} {value}"));
                settings.insert(key.into(), json!(value));
            }
        }
        self.record(
            "更新白板设置",
            location,
            None,
            Some(changes.join("\n")),
            false,
        );
        Ok(())
    }

    pub(in crate::workspace_ai::draft) fn node(
        &self,
        key: &BoardKey,
        id: &str,
    ) -> Result<&BoardNode, String> {
        self.boards[key]
            .board
            .nodes
            .iter()
            .find(|node| node.id == id)
            .ok_or("节点不在指定白板中".into())
    }

    pub(in crate::workspace_ai::draft) fn node_mut(
        &mut self,
        key: &BoardKey,
        id: &str,
    ) -> Result<&mut BoardNode, String> {
        self.board_mut(key)
            .nodes
            .iter_mut()
            .find(|node| node.id == id)
            .ok_or("节点不在指定白板中".into())
    }

    fn edge_location(&self, key: &BoardKey, id: &str) -> Result<String, String> {
        let edge = edge(&self.boards[key].board, id)?;
        Ok(format!(
            "{} / {} → {}",
            self.board_trail(key),
            self.node(key, &edge.from)?.title,
            self.node(key, &edge.to)?.title
        ))
    }
}

fn range(value: f64, low: f64, high: f64, label: &str) -> Result<(), String> {
    if (low..=high).contains(&value) {
        Ok(())
    } else {
        Err(format!("{label}须在 {low} 到 {high} 之间"))
    }
}

fn update_node(node: &mut BoardNode, fields: NodeFields) -> Result<(), String> {
    if let Some(title) = fields.title {
        if title.chars().count() > 600 || title.contains('\0') {
            return Err("标题最多 600 个字符".into());
        }
        if !title.trim().is_empty() {
            node.extra.remove("sticker");
        }
        node.title = title;
    }
    if let Some(summary) = fields.summary {
        markdown_text(&summary)?;
        node.summary = (!summary.is_empty()).then_some(summary);
    }
    if let Some(p) = fields.position {
        p.check()?;
        node.x = p.x;
        node.y = p.y;
    }
    let aspect = node
        .extra
        .get("imageAspect")
        .and_then(Value::as_f64)
        .filter(|r| *r > 0.0);
    if let Some(width) = fields.width {
        let min_width = if aspect.is_some() { 1.0 } else { 120.0 };
        range(width, min_width, 2400.0, "宽")?;
        node.w = width;
    }
    if let Some(aspect) = aspect {
        // Resizing an existing image preserves its aspect ratio.
        if fields.width.is_some() || fields.height.is_some() {
            if fields.width.is_none() {
                node.w = fields.height.unwrap() * aspect;
            }
            range(node.w, 1.0, 2400.0, "图片宽")?;
            let height = node.w / aspect;
            range(height, 1.0, 4000.0, "图片高")?;
            node.extra.insert("h".into(), json!(height));
        }
    } else if let Some(height) = fields.height {
        range(height, 64.0, 4000.0, "高")?;
        node.extra.insert("h".into(), json!(height));
    }
    if fields.width.is_some() || (aspect.is_some() && fields.height.is_some()) {
        let question = question_path(&node.id);
        if let Some(display) = node.docs.iter_mut().find(|doc| doc.path != question)
            .and_then(|doc| doc.image_display.as_mut())
        {
            display.width = node.w;
            display.resized = true;
        }
    }
    if let Some(color) = fields.color {
        node.color = crate::board_layout::node_color(color)?;
    }
    node.updated_at = storage::now_iso();
    Ok(())
}

fn edge<'a>(board: &'a BoardFile, id: &str) -> Result<&'a BoardEdge, String> {
    board
        .edges
        .iter()
        .find(|edge| edge.id == id)
        .ok_or("连线不在指定白板中".into())
}
fn edge_mut<'a>(board: &'a mut BoardFile, id: &str) -> Result<&'a mut BoardEdge, String> {
    board
        .edges
        .iter_mut()
        .find(|edge| edge.id == id)
        .ok_or("连线不在指定白板中".into())
}

fn new_edge(from: String, to: String) -> BoardEdge {
    BoardEdge {
        id: storage::new_id("e"),
        from,
        to,
        directed: true,
        label: None,
        created_at: storage::now_iso(),
        extra: BTreeMap::new(),
    }
}

fn edge_description(
    directed: Option<bool>,
    label: &Option<String>,
    route: &Option<Route>,
) -> Option<String> {
    let mut details = Vec::new();
    if let Some(directed) = directed {
        details.push(if directed { "有向" } else { "无向" }.into());
    }
    if let Some(label) = label {
        details.push(format!(
            "名称 · {}",
            if label.is_empty() { "清空" } else { label }
        ));
    }
    if let Some(route) = route {
        details.push(match route {
            Route::Auto => "自动布线".into(),
            Route::Straight => "直线".into(),
            Route::Bent { control: None } => "弯折线".into(),
            Route::Bent { control: Some(p) } => format!("弯折线 · ({}, {})", p.x, p.y),
        });
    }
    (!details.is_empty()).then(|| details.join("\n"))
}

fn update_edge(
    edge: &mut BoardEdge,
    directed: Option<bool>,
    label: Option<String>,
    route: Option<Route>,
) -> Result<(), String> {
    if let Some(directed) = directed {
        edge.directed = directed;
    }
    if let Some(label) = label {
        edge.label = project_canvas::relation_label(&label)?;
    }
    match route {
        None => {}
        Some(Route::Auto) => {
            edge.extra.remove("route");
        }
        Some(Route::Straight) => {
            edge.extra
                .insert("route".into(), json!({"kind":"straight"}));
        }
        Some(Route::Bent { control }) => {
            let value = if let Some(control) = control {
                control.check()?;
                json!({"kind":"bent","control":control})
            } else {
                json!({"kind":"bent"})
            };
            edge.extra.insert("route".into(), value);
        }
    }
    Ok(())
}

fn flow_owner(node: &BoardNode) -> Option<&str> {
    node.extra.get("flowOwnerId").and_then(Value::as_str)
}

fn flow_members(board: &BoardFile, owner: &str) -> Vec<String> {
    let members: BTreeSet<_> = board
        .nodes
        .iter()
        .filter(|n| flow_owner(n) == Some(owner))
        .map(|n| n.id.as_str())
        .collect();
    let requested = board
        .nodes
        .iter()
        .find(|n| n.id == owner)
        .and_then(|n| n.extra.get("flow")?.get("nodeIds")?.as_array());
    let mut seen = BTreeSet::new();
    requested
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|id| members.contains(id))
        .chain(
            board
                .nodes
                .iter()
                .map(|n| n.id.as_str())
                .filter(|id| members.contains(id)),
        )
        .filter(|id| seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

fn set_flow(board: &mut BoardFile, owner: &str, steps: &[String]) -> Result<(), String> {
    let holder = board
        .nodes
        .iter()
        .find(|n| n.id == owner)
        .ok_or("子流程所属节点已不存在")?;
    if flow_owner(holder).is_some() {
        return Err("子流程步骤不能再嵌套子流程".into());
    }
    let step_set: BTreeSet<_> = steps.iter().map(String::as_str).collect();
    if step_set.len() != steps.len() || step_set.contains(owner) {
        return Err("子流程步骤不能重复或包含它的所属节点".into());
    }
    let old = flow_members(board, owner);
    let joined: BTreeSet<_> = old
        .iter()
        .map(String::as_str)
        .chain(step_set.iter().copied())
        .collect();
    for id in &step_set {
        let node = board
            .nodes
            .iter()
            .find(|n| n.id == *id)
            .ok_or("子流程步骤不在指定白板中")?;
        if node.extra.contains_key("flow")
            || flow_owner(node).is_some_and(|current| current != owner)
        {
            return Err("所选步骤已经属于另一子流程".into());
        }
    }
    if board.edges.iter().any(|edge| {
        step_set.contains(edge.from.as_str()) && !joined.contains(edge.to.as_str())
            || step_set.contains(edge.to.as_str()) && !joined.contains(edge.from.as_str())
    }) {
        return Err("所选步骤仍有外部连线，请先处理这些连线".into());
    }
    for node in &mut board.nodes {
        if node.id == owner {
            if steps.is_empty() {
                node.extra.remove("flow");
            } else {
                node.extra.insert("flow".into(), json!({"nodeIds":steps}));
            }
        } else if step_set.contains(node.id.as_str()) {
            node.extra.insert("flowOwnerId".into(), json!(owner));
        } else if flow_owner(node) == Some(owner) {
            node.extra.remove("flowOwnerId");
        }
    }
    let mut previous = BTreeMap::new();
    board.edges.retain(|edge| {
        if joined.contains(edge.from.as_str()) && joined.contains(edge.to.as_str()) {
            previous.insert((edge.from.clone(), edge.to.clone()), edge.clone());
            false
        } else {
            true
        }
    });
    for pair in steps.windows(2) {
        let (from, to) = (pair[0].clone(), pair[1].clone());
        let mut edge = previous
            .remove(&(from.clone(), to.clone()))
            .unwrap_or_else(|| new_edge(from, to));
        edge.directed = true;
        board.edges.push(edge);
    }
    Ok(())
}
