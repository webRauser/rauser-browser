use brauser_protocol::{Request, Response};
use serde_json::json;

mod common;
use common::{assert_request_round_trips, assert_response_round_trips, schema_subset};

#[test]
fn pin_mutation_has_an_explicit_target_and_two_independent_versions() {
    let request = json!({
        "type":"set_stash_pin", "protocol_version":8, "request_id":"pin",
        "expected_revision":"current", "id":"1".repeat(64),
        "version":"2".repeat(64), "pin_version":"3".repeat(64), "pinned":false
    });
    assert_request_round_trips("SetStashPinRequest", &request);
    for field in [
        "id",
        "version",
        "pin_version",
        "pinned",
        "expected_revision",
    ] {
        let mut missing = request.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Request>(missing.clone()).is_err());
        assert!(!schema_subset::valid("SetStashPinRequest", &missing));
    }
    let mut unsafe_path = request.clone();
    unsafe_path["path"] = json!("outside");
    assert!(serde_json::from_value::<Request>(unsafe_path.clone()).is_err());
    assert!(!schema_subset::valid("SetStashPinRequest", &unsafe_path));

    let response = json!({
        "type":"stash_pin_set", "protocol_version":8, "request_id":"pin",
        "pin":{"pinned":false,"version":"4".repeat(64)}
    });
    assert_response_round_trips("StashPinSet", &response);
    let mut untyped = response;
    untyped["pin"]["pinned"] = json!("false");
    assert!(serde_json::from_value::<Response>(untyped.clone()).is_err());
    assert!(!schema_subset::valid("StashPinSet", &untyped));
}

#[test]
fn pin_list_uses_opt_in_and_accepts_legacy_rows_without_pin() {
    let mut list = json!({
        "type":"list_stash", "protocol_version":8, "request_id":"list",
        "expected_revision":"current", "state":"all", "query":"", "after":null
    });
    assert_request_round_trips("ListStashRequest", &list);
    list["include_pin"] = json!(true);
    assert_request_round_trips("ListStashRequest", &list);
    list["after"] = json!("1".repeat(64));
    list["pin_order"] = json!("4".repeat(64));
    assert_request_round_trips("ListStashRequest", &list);
    list["include_pin"] = json!("yes");
    assert!(serde_json::from_value::<Request>(list.clone()).is_err());
    assert!(!schema_subset::valid("ListStashRequest", &list));

    let mut listed = json!({
        "type":"stash_listed", "protocol_version":8, "request_id":"list", "next":null,
        "items":[{
            "id":"1".repeat(64), "version":"2".repeat(64), "title":"Fixture",
            // timing-ok: The saved time only round-trips as wire metadata.
            "url":"https://example.com/", "saved_at":"2026-11-24T00:00:00Z",
            "done":false, "summary":null
        }]
    });
    // The Rust wire test's schema subset cannot evaluate the existing
    // StashItem dependent schema for summary_issue.
    let round_trip = |wire: &serde_json::Value| {
        let parsed: Response = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), *wire);
    };
    round_trip(&listed);
    listed["pin_order"] = json!("4".repeat(64));
    listed["items"][0]["pin"] = json!({"pinned":true,"version":"3".repeat(64)});
    round_trip(&listed);
    listed["items"][0]["pin"]["extra"] = json!(true);
    assert!(serde_json::from_value::<Response>(listed).is_err());
}
