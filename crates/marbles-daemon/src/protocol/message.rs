use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::{NonEmptyString, ProtocolError};

#[derive(Debug, Clone, PartialEq)]
pub enum WireMessage {
    Request(Request),
    Response(Response),
    Notification(Notification),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: NonEmptyString,
    #[serde(default, deserialize_with = "super::field::absent_or_value")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Response {
    #[serde(default, deserialize_with = "super::field::absent_or_value")]
    pub error: Option<WireError>,
    pub id: u64,
    #[serde(default, deserialize_with = "super::field::absent_or_value")]
    pub result: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Notification {
    pub method: NonEmptyString,
    #[serde(default, deserialize_with = "super::field::absent_or_value")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct WireError {
    pub message: String,
    #[serde(default, deserialize_with = "super::field::absent_or_value")]
    pub name: Option<String>,
}

pub fn encode(message: &WireMessage) -> String {
    match message {
        WireMessage::Request(request) => {
            let id = request.id;
            let method = Value::from(request.method.as_str());
            match &request.params {
                Some(params) => {
                    format!("{{\"id\":{id},\"method\":{method},\"params\":{params}}}\n")
                }
                None => format!("{{\"id\":{id},\"method\":{method}}}\n"),
            }
        }
        WireMessage::Response(response) => {
            let error = response
                .error
                .as_ref()
                .map(|error| format!("\"error\":{},", error.to_value()))
                .unwrap_or_default();
            let result = response
                .result
                .as_ref()
                .map(|result| format!(",\"result\":{result}"))
                .unwrap_or_default();
            format!("{{{error}\"id\":{}{result}}}\n", response.id)
        }
        WireMessage::Notification(notification) => {
            let method = Value::from(notification.method.as_str());
            match &notification.params {
                Some(params) => format!("{{\"method\":{method},\"params\":{params}}}\n"),
                None => format!("{{\"method\":{method}}}\n"),
            }
        }
    }
}

pub fn decode(line: &str) -> Result<WireMessage, ProtocolError> {
    let Value::Object(fields) = serde_json::from_str(line)? else {
        return Err(ProtocolError::NotAnObject);
    };
    classify(fields)
}

impl Request {
    pub fn new(id: u64, method: impl Into<NonEmptyString>) -> Self {
        Self {
            id,
            method: method.into(),
            params: None,
        }
    }

    pub fn with_params(self, params: Value) -> Self {
        Self {
            params: Some(params),
            ..self
        }
    }
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self {
            error: None,
            id,
            result: Some(result),
        }
    }

    pub fn empty(id: u64) -> Self {
        Self {
            error: None,
            id,
            result: None,
        }
    }

    pub fn err(id: u64, error: WireError) -> Self {
        Self {
            error: Some(error),
            id,
            result: None,
        }
    }
}

impl Notification {
    pub fn new(method: impl Into<NonEmptyString>) -> Self {
        Self {
            method: method.into(),
            params: None,
        }
    }

    pub fn with_params(self, params: Value) -> Self {
        Self {
            params: Some(params),
            ..self
        }
    }
}

impl WireError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            name: None,
        }
    }

    pub fn named(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            name: Some(name.into()),
        }
    }

    fn to_value(&self) -> Value {
        let mut fields = Map::new();
        fields.insert("message".to_owned(), Value::from(self.message.as_str()));
        if let Some(name) = &self.name {
            fields.insert("name".to_owned(), Value::from(name.as_str()));
        }
        Value::Object(fields)
    }
}

impl From<Request> for WireMessage {
    fn from(request: Request) -> Self {
        Self::Request(request)
    }
}

impl From<Response> for WireMessage {
    fn from(response: Response) -> Self {
        Self::Response(response)
    }
}

impl From<Notification> for WireMessage {
    fn from(notification: Notification) -> Self {
        Self::Notification(notification)
    }
}

fn classify(fields: Map<String, Value>) -> Result<WireMessage, ProtocolError> {
    match (fields.contains_key("id"), fields.contains_key("method")) {
        (true, true) => Ok(WireMessage::Request(from_fields(fields)?)),
        (true, false) => Ok(WireMessage::Response(from_fields(fields)?)),
        (false, true) => Ok(WireMessage::Notification(from_fields(fields)?)),
        (false, false) => Err(ProtocolError::MissingIdAndMethod),
    }
}

fn from_fields<T: DeserializeOwned>(fields: Map<String, Value>) -> Result<T, ProtocolError> {
    Ok(serde_json::from_value(Value::Object(fields))?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_json::non_empty;
    use super::super::{ClientNotification, DaemonMethod};
    use super::*;

    fn encoded(message: impl Into<WireMessage>) -> String {
        encode(&message.into())
    }

    fn decoded(line: &str) -> WireMessage {
        decode(line).expect("the line should decode")
    }

    #[test]
    fn request_encodes_compactly_with_a_trailing_newline() {
        let request = Request::new(7, DaemonMethod::Hello).with_params(json!({ "a": 1 }));

        assert_eq!(
            encoded(request),
            "{\"id\":7,\"method\":\"hello\",\"params\":{\"a\":1}}\n"
        );
    }

    #[test]
    fn request_without_params_omits_the_key() {
        assert_eq!(
            encoded(Request::new(0, DaemonMethod::Hello)),
            "{\"id\":0,\"method\":\"hello\"}\n"
        );
    }

    #[test]
    fn successful_response_puts_id_before_result() {
        assert_eq!(
            encoded(Response::ok(3, json!([1, 2]))),
            "{\"id\":3,\"result\":[1,2]}\n"
        );
    }

    #[test]
    fn empty_response_carries_only_the_id() {
        assert_eq!(encoded(Response::empty(3)), "{\"id\":3}\n");
    }

    #[test]
    fn failed_response_puts_error_before_id() {
        let response = Response::err(4, WireError::new("boom"));

        assert_eq!(
            encoded(response),
            "{\"error\":{\"message\":\"boom\"},\"id\":4}\n"
        );
    }

    #[test]
    fn named_wire_error_includes_the_name() {
        let response = Response::err(4, WireError::named("EngineRetiringError", "moving"));

        assert_eq!(
            encoded(response),
            "{\"error\":{\"message\":\"moving\",\"name\":\"EngineRetiringError\"},\"id\":4}\n"
        );
    }

    #[test]
    fn notification_encodes_method_then_params() {
        let notification =
            Notification::new(ClientNotification::Line).with_params(json!({ "line": "hi" }));

        assert_eq!(
            encoded(notification),
            "{\"method\":\"line\",\"params\":{\"line\":\"hi\"}}\n"
        );
    }

    #[test]
    fn strings_and_nested_params_are_escaped_and_keep_their_order() {
        let notification = Notification::new(non_empty("say \"hi\""))
            .with_params(json!({ "zeta": 1, "alpha": { "y": "\n", "b": [true, null] } }));

        assert_eq!(
            encoded(notification),
            "{\"method\":\"say \\\"hi\\\"\",\"params\":{\"zeta\":1,\"alpha\":{\"y\":\"\\n\",\"b\":[true,null]}}}\n"
        );
    }

    #[test]
    fn encoding_matches_serialising_through_serde() {
        let params = json!({ "id": "w1", "text": "\u{2603} \u{0007}", "n": 1.5 });
        let line = encoded(Request::new(9, DaemonMethod::Attach).with_params(params.clone()));
        let expected = json!({ "id": 9, "method": "attach", "params": params });

        assert_eq!(line, format!("{expected}\n"));
        assert_eq!(
            serde_json::from_str::<Value>(&line).expect("the line should parse"),
            expected
        );
    }

    #[test]
    fn every_message_kind_roundtrips() {
        let messages: Vec<WireMessage> = vec![
            Request::new(1, DaemonMethod::Attach)
                .with_params(json!({ "source": "." }))
                .into(),
            Response::ok(1, json!({ "ok": true })).into(),
            Response::empty(2).into(),
            Response::err(3, WireError::named("TypeError", "bad")).into(),
            Notification::new(ClientNotification::Workspace).into(),
        ];

        for message in messages {
            assert_eq!(decoded(&encoded(message.clone())), message);
        }
    }

    #[test]
    fn id_and_method_make_a_request() {
        assert_eq!(
            decoded("{\"id\":1,\"method\":\"hello\"}"),
            Request::new(1, DaemonMethod::Hello).into()
        );
    }

    #[test]
    fn id_without_method_makes_a_response() {
        assert_eq!(
            decoded("{\"id\":1,\"result\":5}"),
            Response::ok(1, json!(5)).into()
        );
    }

    #[test]
    fn method_without_id_makes_a_notification() {
        assert_eq!(
            decoded("{\"method\":\"line\"}"),
            Notification::new(ClientNotification::Line).into()
        );
    }

    #[test]
    fn request_with_an_empty_method_is_rejected_not_read_as_a_response() {
        let result = decode("{\"id\":1,\"method\":\"\"}");

        assert!(matches!(result, Err(ProtocolError::Malformed(_))));
    }

    #[test]
    fn notification_with_an_empty_method_is_rejected() {
        let result = decode("{\"method\":\"\"}");

        assert!(matches!(result, Err(ProtocolError::Malformed(_))));
    }

    #[test]
    fn negative_id_is_rejected() {
        assert!(matches!(
            decode("{\"id\":-1,\"result\":1}"),
            Err(ProtocolError::Malformed(_))
        ));
        assert!(matches!(
            decode("{\"id\":-1,\"method\":\"hello\"}"),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn fractional_id_is_rejected() {
        assert!(matches!(
            decode("{\"id\":1.5}"),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn non_string_method_is_rejected() {
        assert!(matches!(
            decode("{\"id\":1,\"method\":5}"),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn message_without_id_or_method_is_rejected() {
        assert!(matches!(
            decode("{\"result\":1}"),
            Err(ProtocolError::MissingIdAndMethod)
        ));
    }

    #[test]
    fn non_object_json_is_rejected() {
        assert!(matches!(decode("[1]"), Err(ProtocolError::NotAnObject)));
    }

    #[test]
    fn invalid_json_is_rejected() {
        assert!(matches!(
            decode("{\"id\":"),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn unknown_fields_on_a_response_are_ignored() {
        assert_eq!(
            decoded("{\"id\":2,\"result\":true,\"extra\":\"x\"}"),
            Response::ok(2, json!(true)).into()
        );
    }

    #[test]
    fn explicit_null_result_survives_a_roundtrip() {
        let line = "{\"id\":2,\"result\":null}";

        assert_eq!(encoded(decoded(line)), format!("{line}\n"));
    }

    #[test]
    fn explicit_null_error_is_rejected() {
        assert!(matches!(
            decode("{\"id\":2,\"error\":null}"),
            Err(ProtocolError::Malformed(_))
        ));
    }

    #[test]
    fn error_without_a_message_is_rejected() {
        assert!(matches!(
            decode("{\"id\":2,\"error\":{\"name\":\"TypeError\"}}"),
            Err(ProtocolError::Malformed(_))
        ));
    }
}
