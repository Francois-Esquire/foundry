use std::fmt;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::str::FromStr;

use sha2::{Digest, Sha256};
use thiserror::Error;

const DIGEST_BYTES: usize = 32;
const HEX_DIGITS: usize = DIGEST_BYTES * 2;
const SHORT_HEX_DIGITS: usize = 12;
const READ_CHUNK_BYTES: usize = 64 * 1024;
const LOWER_HEX: &[u8; 16] = b"0123456789abcdef";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BinaryDigest([u8; DIGEST_BYTES]);

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("a binary digest must be {HEX_DIGITS} hexadecimal digits")]
pub struct InvalidDigest;

impl BinaryDigest {
    pub fn hash_file(path: &Path) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; READ_CHUNK_BYTES];
        loop {
            match file.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => hasher.update(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
        Ok(Self(hasher.finalize().into()))
    }

    pub fn short_hex(&self) -> String {
        let mut hex = self.to_string();
        hex.truncate(SHORT_HEX_DIGITS);
        hex
    }
}

impl fmt::Display for BinaryDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for byte in self.0 {
            let high = LOWER_HEX[usize::from(byte >> 4)];
            let low = LOWER_HEX[usize::from(byte & 0x0f)];
            write!(formatter, "{}{}", char::from(high), char::from(low))?;
        }
        Ok(())
    }
}

impl FromStr for BinaryDigest {
    type Err = InvalidDigest;

    fn from_str(hex: &str) -> Result<Self, Self::Err> {
        let digits = hex.as_bytes();
        if digits.len() != HEX_DIGITS {
            return Err(InvalidDigest);
        }
        let mut bytes = [0; DIGEST_BYTES];
        for (byte, pair) in bytes.iter_mut().zip(digits.chunks_exact(2)) {
            *byte = (nibble(pair[0])? << 4) | nibble(pair[1])?;
        }
        Ok(Self(bytes))
    }
}

fn nibble(digit: u8) -> Result<u8, InvalidDigest> {
    match digit {
        b'0'..=b'9' => Ok(digit - b'0'),
        b'a'..=b'f' => Ok(digit - b'a' + 10),
        b'A'..=b'F' => Ok(digit - b'A' + 10),
        _ => Err(InvalidDigest),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn hashed(bytes: &[u8]) -> BinaryDigest {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("binary");
        fs::write(&path, bytes).expect("the binary");
        BinaryDigest::hash_file(&path).expect("the digest")
    }

    #[test]
    fn hashing_matches_the_sha256_test_vectors() {
        assert_eq!(hashed(b"abc").to_string(), ABC_SHA256);
        assert_eq!(hashed(b"").to_string(), EMPTY_SHA256);
    }

    #[test]
    fn hashing_streams_files_larger_than_one_chunk() {
        let bytes = vec![7; READ_CHUNK_BYTES * 3 + 5];

        let digest = hashed(&bytes);

        assert_eq!(digest, BinaryDigest(Sha256::digest(&bytes).into()));
    }

    #[test]
    fn the_short_hex_is_the_first_twelve_digits() {
        assert_eq!(hashed(b"abc").short_hex(), "ba7816bf8f01");
    }

    #[test]
    fn hex_round_trips_and_accepts_uppercase() {
        let digest: BinaryDigest = ABC_SHA256.parse().expect("a digest");

        assert_eq!(digest.to_string(), ABC_SHA256);
        assert_eq!(ABC_SHA256.to_uppercase().parse(), Ok(digest));
    }

    #[test]
    fn malformed_hex_is_refused() {
        assert_eq!("".parse::<BinaryDigest>(), Err(InvalidDigest));
        assert_eq!(ABC_SHA256[1..].parse::<BinaryDigest>(), Err(InvalidDigest));
        assert_eq!(
            format!("{ABC_SHA256}0").parse::<BinaryDigest>(),
            Err(InvalidDigest)
        );
        assert_eq!(
            format!("{}g", &ABC_SHA256[1..]).parse::<BinaryDigest>(),
            Err(InvalidDigest)
        );
        assert_eq!(
            format!("{}é", &ABC_SHA256[2..]).parse::<BinaryDigest>(),
            Err(InvalidDigest)
        );
    }
}
