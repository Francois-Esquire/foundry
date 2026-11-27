use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct NonEmptyString(String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("must not be empty")]
pub struct EmptyString;

impl NonEmptyString {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(super) fn from_wire_name(name: &'static str) -> Self {
        Self(name.to_owned())
    }
}

impl TryFrom<String> for NonEmptyString {
    type Error = EmptyString;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty() {
            Err(EmptyString)
        } else {
            Ok(Self(value))
        }
    }
}

impl From<NonEmptyString> for String {
    fn from(value: NonEmptyString) -> Self {
        value.0
    }
}

impl AsRef<str> for NonEmptyString {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NonEmptyString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_string_is_refused() {
        assert_eq!(NonEmptyString::try_from(String::new()), Err(EmptyString));
        assert!(serde_json::from_str::<NonEmptyString>(r#""""#).is_err());
    }

    #[test]
    fn a_non_empty_string_roundtrips() {
        let value: NonEmptyString = serde_json::from_str(r#""w1""#).expect("a non-empty string");

        assert_eq!(value.as_str(), "w1");
        assert_eq!(value.to_string(), "w1");
        assert_eq!(
            serde_json::to_string(&value).expect("the value should serialize"),
            r#""w1""#
        );
        assert_eq!(String::from(value), "w1");
    }
}
