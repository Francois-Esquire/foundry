use std::fmt::Debug;

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::NonEmptyString;

pub(super) fn to_json(value: &impl Serialize) -> String {
    serde_json::to_string(value).expect("the payload should serialize")
}

pub(super) fn from_json<T: DeserializeOwned>(text: &str) -> Result<T, serde_json::Error> {
    serde_json::from_str(text)
}

pub(super) fn assert_roundtrip<T>(value: &T, expected: &str)
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    assert_eq!(to_json(value), expected);
    assert_eq!(
        &from_json::<T>(expected).expect("the payload should parse"),
        value
    );
}

pub(super) fn non_empty(value: &str) -> NonEmptyString {
    NonEmptyString::try_from(value.to_owned()).expect("a non-empty value")
}
