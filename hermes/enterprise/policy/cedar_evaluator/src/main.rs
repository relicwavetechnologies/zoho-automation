use cedar_policy::{
    Authorizer, Context, Decision, Entities, EntityId, EntityTypeName, EntityUid, PolicySet,
    Request, Schema,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{self, Read};
use std::str::FromStr;
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct EvaluateInput {
    protocol_version: Option<u32>,
    op: Option<String>,
    request_id: Option<String>,
    policy_set: SourceInput,
    schema: Option<SourceInput>,
    request: RequestInput,
    entities: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct SourceInput {
    format: Option<String>,
    source: String,
}

#[derive(Debug, Deserialize)]
struct RequestInput {
    principal: EntityRef,
    action: EntityRef,
    resource: EntityRef,
    context: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct EntityRef {
    #[serde(rename = "type")]
    entity_type: String,
    id: String,
}

fn main() {
    let started = Instant::now();
    let output = match read_input().and_then(|input| evaluate(input, started)) {
        Ok(value) => value,
        Err(err) => error_json("cedar_evaluator_error", &err, started),
    };
    println!(
        "{}",
        serde_json::to_string(&output).unwrap_or_else(|_| {
            "{\"protocol_version\":1,\"ok\":false,\"decision\":\"deny\",\"allowed\":false}".to_string()
        })
    );
}

fn read_input() -> Result<EvaluateInput, String> {
    let mut buffer = String::new();
    io::stdin()
        .read_to_string(&mut buffer)
        .map_err(|err| format!("failed to read stdin: {err}"))?;
    serde_json::from_str(&buffer).map_err(|err| format!("invalid input json: {err}"))
}

fn evaluate(input: EvaluateInput, started: Instant) -> Result<Value, String> {
    if input.protocol_version.unwrap_or(1) != 1 {
        return Err("unsupported protocol_version".to_string());
    }
    if input.op.as_deref().unwrap_or("authorize") != "authorize" {
        return Err("unsupported op".to_string());
    }

    let policy_source = input.policy_set.source.trim();
    if policy_source.is_empty() {
        return Err("policy_set.source is required".to_string());
    }
    let policy_set = PolicySet::from_str(policy_source)
        .map_err(|err| format!("policy parse error: {err}"))?;

    let schema = parse_schema(input.schema.as_ref())?;
    let principal = entity_uid(&input.request.principal)?;
    let action = entity_uid(&input.request.action)?;
    let resource = entity_uid(&input.request.resource)?;

    let context_value = input.request.context.unwrap_or_else(|| json!({}));
    let context = match schema.as_ref() {
        Some(schema) => Context::from_json_value(context_value, Some((schema, &action)))
            .map_err(|err| format!("context parse error: {err}"))?,
        None => Context::from_json_value(context_value, None)
            .map_err(|err| format!("context parse error: {err}"))?,
    };

    let request = Request::new(principal, action, resource, context, schema.as_ref())
        .map_err(|err| format!("request validation error: {err}"))?;
    let entities_value = input.entities.unwrap_or_else(|| json!([]));
    let entities = Entities::from_json_value(entities_value, schema.as_ref())
        .map_err(|err| format!("entities parse error: {err}"))?;

    let response = Authorizer::new().is_authorized(&request, &policy_set, &entities);
    let decision = match response.decision() {
        Decision::Allow => "allow",
        Decision::Deny => "deny",
    };
    let reason_policy_ids: Vec<String> = response
        .diagnostics()
        .reason()
        .map(|reason| reason.to_string())
        .collect();
    let errors: Vec<String> = response
        .diagnostics()
        .errors()
        .map(|error| error.to_string())
        .collect();

    Ok(json!({
        "protocol_version": 1,
        "ok": true,
        "decision": decision,
        "allowed": response.decision() == Decision::Allow,
        "request_id": input.request_id.unwrap_or_default(),
        "reason_policy_ids": reason_policy_ids,
        "errors": errors,
        "policy_checksum": checksum(policy_source),
        "schema_checksum": input.schema.as_ref().map(|source| checksum(source.source.as_str())).unwrap_or_default(),
        "duration_ms": started.elapsed().as_millis() as u64,
    }))
}

fn parse_schema(source: Option<&SourceInput>) -> Result<Option<Schema>, String> {
    let Some(source) = source else {
        return Ok(None);
    };
    let body = source.source.trim();
    if body.is_empty() {
        return Ok(None);
    }
    let format = source
        .format
        .as_deref()
        .unwrap_or("cedar")
        .trim()
        .to_ascii_lowercase();
    match format.as_str() {
        "cedar" | "cedarschema" => {
            let (schema, _warnings) = Schema::from_cedarschema_str(body)
                .map_err(|err| format!("schema parse error: {err}"))?;
            Ok(Some(schema))
        }
        "json" => Schema::from_json_str(body)
            .map(Some)
            .map_err(|err| format!("schema parse error: {err}")),
        other => Err(format!("unsupported schema format: {other}")),
    }
}

fn entity_uid(entity: &EntityRef) -> Result<EntityUid, String> {
    let entity_type = EntityTypeName::from_str(entity.entity_type.trim())
        .map_err(|err| format!("invalid entity type {}: {err}", entity.entity_type))?;
    let entity_id = EntityId::from_str(entity.id.trim())
        .map_err(|err| format!("invalid entity id {}: {err}", entity.id))?;
    Ok(EntityUid::from_type_name_and_id(entity_type, entity_id))
}

fn error_json(code: &str, message: &str, started: Instant) -> Value {
    json!({
        "protocol_version": 1,
        "ok": false,
        "decision": "deny",
        "allowed": false,
        "error": {
            "code": code,
            "message": message,
        },
        "errors": [message],
        "duration_ms": started.elapsed().as_millis() as u64,
    })
}

fn checksum(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    format!("sha256:{digest:x}")
}
