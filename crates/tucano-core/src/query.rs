use crate::{state::AppState, storage::Flow};
use rusqlite::{params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub filter: Option<String>,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub sort: Option<String>,
    pub descending: Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Flow>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

fn field(name: &str) -> Option<(&'static str, bool)> {
    Some(match name {
    "host"=>("json_extract(data,'$.host')",false),"path"=>("json_extract(data,'$.path')",false),
    "method"=>("json_extract(data,'$.method')",false),"scheme"=>("json_extract(data,'$.scheme')",false),
    "status"=>("json_extract(data,'$.status')",true),"duration"|"durationMs"=>("json_extract(data,'$.durationMs')",true),
    "mime"=>("coalesce(json_extract(data,'$.resContentType'),json_extract(data,'$.reqContentType'),'')",false),
    "startedAt"=>("json_extract(data,'$.startedAt')",true),"index"=>("idx",true),
    "size"=>("(json_extract(data,'$.reqSize')+json_extract(data,'$.resSize'))",true),
    "mark"=>("json_extract(data,'$.mark')",false),_=>return None})
}
fn tokens(filter: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    for c in filter.chars() {
        match c {
            '"' | '\'' if quote == Some(c) => quote = None,
            '"' | '\'' if quote.is_none() => quote = Some(c),
            c if c.is_whitespace() && quote.is_none() => {
                if !token.is_empty() {
                    tokens.push(std::mem::take(&mut token));
                }
            }
            c => token.push(c),
        }
    }
    if quote.is_some() {
        return Err("unterminated filter quote".into());
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    Ok(tokens)
}
fn predicates(filter: &str) -> Result<(String, Vec<SqlValue>), String> {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for token in tokens(filter)? {
        let rule = token
            .split_once(':')
            .and_then(|(name, value)| field(name).map(|f| (f, value)));
        // Accept status>=400 as well as status:>=400.
        let rule = rule.or_else(|| {
            token
                .find(['>', '<', '='])
                .and_then(|i| field(&token[..i]).map(|f| (f, &token[i..])))
        });
        if let Some(((expression, numeric), value)) = rule {
            if numeric {
                let (op, number) = [">=", "<=", ">", "<", "="]
                    .into_iter()
                    .find_map(|op| value.strip_prefix(op).map(|n| (op, n)))
                    .unwrap_or(("=", value));
                let n = number
                    .trim_end_matches("ms")
                    .parse::<i64>()
                    .map_err(|_| format!("invalid numeric filter: {token}"))?;
                clauses.push(format!("{expression} {op} ?"));
                params.push(SqlValue::Integer(n));
            } else {
                clauses.push(format!(
                    "instr(lower(coalesce({expression},'')),lower(?))>0"
                ));
                params.push(SqlValue::Text(value.into()));
            }
        } else {
            clauses.push("instr(lower(coalesce(json_extract(data,'$.host'),'')||' '||coalesce(json_extract(data,'$.path'),'')||' '||coalesce(json_extract(data,'$.method'),'')||' '||coalesce(json_extract(data,'$.clientApp'),'')),lower(?))>0".into());
            params.push(SqlValue::Text(token));
        }
    }
    Ok((
        if clauses.is_empty() {
            "1".into()
        } else {
            clauses.join(" AND ")
        },
        params,
    ))
}
pub fn query_flows(state: Arc<AppState>, query: Query) -> Result<Page, String> {
    let limit = query.limit.unwrap_or(100).clamp(1, 1000);
    let offset = query.offset.unwrap_or(0).min(i64::MAX as usize);
    let (predicate, mut params) = predicates(query.filter.as_deref().unwrap_or(""))?;
    let sort = query.sort.as_deref().unwrap_or("index");
    let expression = field(sort)
        .ok_or_else(|| format!("unsupported sort: {sort}"))?
        .0;
    let order = if query.descending.unwrap_or(false) {
        "DESC"
    } else {
        "ASC"
    };
    let storage = state.storage.lock();
    let total: i64 = storage
        .conn
        .query_row(
            &format!("SELECT count(*) FROM flows WHERE {predicate}"),
            params_from_iter(params.iter()),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    params.push(SqlValue::Integer(limit as i64));
    params.push(SqlValue::Integer(offset as i64));
    // SQLite removes bodies before allocating the Rust string or deserializing Flow.
    let sql=format!("SELECT json_set(data,'$.reqBody',null,'$.resBody',null) FROM flows WHERE {predicate} ORDER BY {expression} {order},idx {order},id {order} LIMIT ? OFFSET ?");
    let mut stmt = storage.conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut items = Vec::with_capacity(limit);
    for row in rows {
        items.push(
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        );
    }
    let next = offset + items.len();
    Ok(Page {
        items,
        total: total as usize,
        next_offset: (next < total as usize).then_some(next),
    })
}
pub fn get_stats(state: Arc<AppState>) -> Result<Value, String> {
    let storage = state.storage.lock();
    let totals=storage.conn.query_row("SELECT count(*),coalesce(sum(json_extract(data,'$.reqSize')),0),coalesce(sum(json_extract(data,'$.resSize')),0),coalesce(avg(json_extract(data,'$.durationMs')),0),coalesce(sum(CASE WHEN json_extract(data,'$.error') IS NOT NULL THEN 1 ELSE 0 END),0) FROM flows",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,f64>(3)?,r.get::<_,i64>(4)?))).map_err(|e|e.to_string())?;
    let mut result = json!({"total":totals.0,"totalFlows":totals.0,"requestBytes":totals.1,"responseBytes":totals.2,"averageDurationMs":totals.3,"errors":totals.4});
    for (name, field) in [
        ("methods", "method"),
        ("hosts", "host"),
        ("statuses", "status"),
    ] {
        let mut stmt=storage.conn.prepare(&format!("SELECT coalesce(CAST(json_extract(data,'$.{field}') AS TEXT),'pending'),count(*) FROM flows GROUP BY 1 ORDER BY 2 DESC LIMIT 100")).map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (key, count) = row.map_err(|e| e.to_string())?;
            map.insert(key, json!(count));
        }
        result[name] = Value::Object(map);
    }
    Ok(result)
}
pub fn export_flows(
    state: Arc<AppState>,
    format: &str,
    ids: Option<Vec<String>>,
) -> Result<String, String> {
    let flows = {
        let storage = state.storage.lock();
        match ids {
            Some(ids) => ids
                .iter()
                .map(|id| {
                    storage
                        .get(id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| format!("flow not found: {id}"))
                })
                .collect::<Result<Vec<_>, _>>()?,
            None => storage.list().map_err(|e| e.to_string())?,
        }
    };
    match format {
        "json" => serde_json::to_string_pretty(&flows).map_err(|e| e.to_string()),
        "har" => serde_json::to_string_pretty(&crate::mcp_bridge::flow_to_har(&flows))
            .map_err(|e| e.to_string()),
        "curl" => Ok(flows
            .iter()
            .map(|f| crate::mcp_bridge::flow_to_curl(f, true))
            .collect::<Vec<_>>()
            .join("\n\n")),
        _ => Err("format must be har, curl or json".into()),
    }
}
