use brauser_protocol::{Request, Response};
use serde_json::{Value, json};

mod common;
use common::schema_subset;

fn request() -> Value {
    json!({"type":"explore_artifacts", "protocol_version":8, "request_id":"explore",
        "expected_revision":"sha256:config", "query":null, "source":null,
        "artifact_type":null, "category":null, "document_type":null, "reading":null,
        "limit":8, "page":{"offset":0}})
}

fn artifact() -> Value {
    json!({"artifact_id":"work:work.example/7", "artifact_type":"work.item", "title":"Release plan",
        "url":"https://work.example/items/7", "source":"work.example",
        "first_seen":"2026-11-01", "last_seen":"2026-11-23", "focused_seconds":90,
        "opens":2, "why":null, "summary":null})
}

fn facets() -> Value {
    json!({"sources":[{"value":"work.example", "count":1}],
        "artifact_types":[{"value":"work.item", "count":1}], "categories":[],
        "document_types":[], "truncated":false})
}

fn result() -> Value {
    json!({"type":"explore_artifacts_result", "protocol_version":8, "request_id":"explore",
        "items":[artifact()], "facets":facets(), "total":1, "library_total":1,
        "page":{"offset":0, "snapshot":"a".repeat(64), "next_offset":null}})
}

fn connection() -> Value {
    json!({"artifact":artifact(), "basis":"same_category", "direction":"associated",
        "transition":null, "last_seen":null})
}

#[test]
fn explorer_requests_require_explicit_nullable_filters_and_known_reading_values() {
    common::assert_request_round_trips("ExploreArtifactsRequest", &request());
    for field in [
        "query",
        "source",
        "artifact_type",
        "category",
        "document_type",
        "reading",
    ] {
        let mut missing = request();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            !schema_subset::valid("ExploreArtifactsRequest", &missing),
            "{field}"
        );
        assert!(
            serde_json::from_value::<Request>(missing).is_err(),
            "{field}"
        );
    }
    for reading in ["limited", "whole", "unknown", "none"] {
        let mut filtered = request();
        filtered["reading"] = json!(reading);
        common::assert_request_round_trips("ExploreArtifactsRequest", &filtered);
    }
    let mut invalid = request();
    invalid["reading"] = json!("partial");
    assert!(!schema_subset::valid("ExploreArtifactsRequest", &invalid));
    assert!(serde_json::from_value::<Request>(invalid).is_err());
}

#[test]
fn explorer_request_bounds_and_continuation_shapes_are_pinned() {
    for (key, valid, invalid) in [
        ("query", 256, 257),
        ("source", 253, 254),
        ("artifact_type", 64, 65),
        ("category", 64, 65),
        ("document_type", 64, 65),
    ] {
        let mut value = request();
        value[key] = json!("é".repeat(valid));
        common::assert_request_round_trips("ExploreArtifactsRequest", &value);
        value[key] = json!("é".repeat(invalid));
        assert!(
            !schema_subset::valid("ExploreArtifactsRequest", &value),
            "{key}"
        );
    }
    for limit in [0, 9] {
        let mut value = request();
        value["limit"] = json!(limit);
        assert!(!schema_subset::valid("ExploreArtifactsRequest", &value));
    }
    let mut next = request();
    next["page"] = json!({"offset":8, "snapshot":"a".repeat(64)});
    common::assert_request_round_trips("ExploreArtifactsRequest", &next);
    for page in [
        json!({"offset":-1}),
        json!({"offset":0,"snapshot":"short"}),
        json!({"offset":0,"snapshot":"a".repeat(65)}),
        json!({"offset":0,"path":"/tmp"}),
    ] {
        next["page"] = page;
        assert!(!schema_subset::valid("ExploreArtifactsRequest", &next));
    }
    let context = json!({"type":"get_artifact_context", "protocol_version":8,
        "request_id":"context", "expected_revision":"sha256:config", "artifact_id":"work:work.example/7"});
    common::assert_request_round_trips("GetArtifactContextRequest", &context);
    for field in ["expected_revision", "artifact_id"] {
        let mut missing = context.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<Request>(missing).is_err(),
            "{field}"
        );
    }
}

#[test]
fn explorer_results_bound_rows_facets_and_connections_and_preserve_nullability() {
    common::assert_response_round_trips("ExploreArtifactsResult", &result());
    let mut list = result();
    list["items"] = json!(vec![artifact(); 8]);
    assert!(schema_subset::valid("ExploreArtifactsResult", &list));
    list["items"] = json!(vec![artifact(); 9]);
    assert!(!schema_subset::valid("ExploreArtifactsResult", &list));
    for key in ["sources", "artifact_types", "categories", "document_types"] {
        let mut value = facets();
        value[key] = json!(vec![json!({"value":"category", "count":1}); 64]);
        assert!(schema_subset::valid("ExplorerFacets", &value));
        value[key] = json!(vec![json!({"value":"category", "count":1}); 65]);
        assert!(!schema_subset::valid("ExplorerFacets", &value), "{key}");
        let max = if key == "sources" { 253 } else { 64 };
        value[key] = json!([{"value":"é".repeat(max),"count":1}]);
        assert!(schema_subset::valid("ExplorerFacets", &value), "{key}");
        value[key] = json!([{"value":"é".repeat(max+1),"count":1}]);
        assert!(!schema_subset::valid("ExplorerFacets", &value), "{key}");
    }
    let mut context = json!({"type":"artifact_context_result", "protocol_version":8,
        "request_id":"context", "item":null, "connections":[], "truncated":false});
    common::assert_response_round_trips("ArtifactContextResult", &context);
    context["item"] = artifact();
    context["connections"] = json!(vec![connection(); 8]);
    common::assert_response_round_trips("ArtifactContextResult", &context);
    context["connections"] = json!(vec![connection(); 9]);
    assert!(!schema_subset::valid("ArtifactContextResult", &context));
    for field in ["why", "summary"] {
        let mut missing = result();
        missing["items"][0].as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<Response>(missing).is_err(),
            "{field}"
        );
    }
    for field in ["transition", "last_seen"] {
        let mut missing = json!({"type":"artifact_context_result", "protocol_version":8,
            "request_id":"context", "item":artifact(), "connections":[connection()], "truncated":false});
        missing["connections"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            serde_json::from_value::<Response>(missing).is_err(),
            "{field}"
        );
    }
}

#[test]
fn explorer_closed_records_reject_unknown_fields_and_evidence_kinds() {
    for pointer in ["", "/items/0", "/facets", "/facets/sources/0", "/page"] {
        let mut value = result();
        value
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), json!(true));
        assert!(
            !schema_subset::valid("ExploreArtifactsResult", &value),
            "{pointer}"
        );
        assert!(
            serde_json::from_value::<Response>(value).is_err(),
            "{pointer}"
        );
    }
    let mut value = request();
    value["path"] = json!("/tmp/library");
    assert!(serde_json::from_value::<Request>(value).is_err());
    for basis in ["navigation", "title_mention", "container", "same_category"] {
        let mut value = connection();
        value["basis"] = json!(basis);
        assert!(schema_subset::valid("ExplorerConnection", &value));
    }
    let mut value = json!({"type":"artifact_context_result", "protocol_version":8,
        "request_id":"context", "item":artifact(), "connections":[connection()], "truncated":false});
    value["connections"][0]["basis"] = json!("fixes");
    assert!(!schema_subset::valid("ArtifactContextResult", &value));
    assert!(serde_json::from_value::<Response>(value).is_err());
}
