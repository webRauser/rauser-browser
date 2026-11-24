use brauser_protocol::{Request, Response};
use serde_json::{Value, json};

fn request() -> Value {
    json!({"type":"record_outbound_links", "protocol_version":8, "request_id":"links",
        "observation": {"observation_id":"00000000-0000-4000-8000-000000000002",
            "source":{"kind":"activity", "event_id":"00000000-0000-4000-8000-000000000001",
                "occurred_at":"2026-11-01T10:00:00Z", "url":"https://work.example/items/1"}, // timing-ok: wire-only fixture, never compared to the clock.
            "observed_at":"2026-11-01T10:00:00Z", "document_url":"https://work.example/items/1", // timing-ok: wire-only fixture, never compared to the clock.
            "frame_scope":"top_document", "frame_id":0, "policy_revision":"revision",
            "coverage":{"state":"complete", "reason":null, "anchors_inspected":1},
            "targets":[{"artifact_id":"work:2", "artifact_type":"work.item",
                "url":"https://work.example/items/2", "label":"Item 2"}]}})
}

#[test]
fn outbound_observations_are_separate_strict_additive_messages() {
    let value = request();
    let decoded: Request = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    for (field, replacement) in [
        ("frame_scope", json!("all_frames")),
        (
            "targets",
            json!([{"url":"https://work.example/items/2", "raw_href":"private"}]),
        ),
    ] {
        let mut forged = request();
        forged["observation"][field] = replacement;
        assert!(serde_json::from_value::<Request>(forged).is_err());
    }
    for field in ["raw_hrefs", "stripped_params", "source_artifact_id"] {
        let mut forged = request();
        forged["observation"][field] = json!([]);
        assert!(serde_json::from_value::<Request>(forged).is_err());
    }
    for state in ["complete", "partial", "unavailable"] {
        let mut value = request();
        value["observation"]["coverage"]["state"] = json!(state);
        assert!(serde_json::from_value::<Request>(value).is_ok());
    }
    let reply = json!({"type":"outbound_links_recorded", "protocol_version":8,
        "request_id":"links", "observation_id":"00000000-0000-4000-8000-000000000002",
        "outcome":"persisted", "reason":null, "relative_path":"log/day.md"});
    let decoded: Response = serde_json::from_value(reply.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), reply);
}
