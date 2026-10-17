//! The errors of `aparte/1` (spec/FORMAT.md section 12).
//!
//! The codes are stable and shared with the web app (`web/src/core/contracts/crypto.ts`): callers branch on
//! [`Error::code`], never on the message, which only adds a detail for logs.

use std::fmt;

/// The stable error codes of spec/FORMAT.md section 12, spelled as the TypeScript contract spells them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// The passphrase, Secret Key, recovery key or passkey does not open the slot (commit mismatch).
    WrongSecret,
    /// A keyslot this build will not run: unknown format, kind or algorithm, or a parameter out of bounds.
    UnsupportedKeyslot,
    /// An envelope or store of another format version or key epoch.
    UnsupportedFormat,
    /// Malformed data: bad JSON, bad encoding, bad length, bad padding, a name or header that does not match.
    Corrupt,
    /// Authentication failed: an AES-GCM tag, or `mkCheck` after a successful unwrap.
    Tampered,
    /// The operation needs the vault's keys and the vault is locked.
    Locked,
    /// A caller or user input is malformed.
    InvalidInput,
    /// The operation is not allowed in the current state.
    InvalidState,
}

impl ErrorCode {
    /// The code as written in spec/FORMAT.md and the TypeScript contract.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WrongSecret => "wrong-secret",
            Self::UnsupportedKeyslot => "unsupported-keyslot",
            Self::UnsupportedFormat => "unsupported-format",
            Self::Corrupt => "corrupt",
            Self::Tampered => "tampered",
            Self::Locked => "locked",
            Self::InvalidInput => "invalid-input",
            Self::InvalidState => "invalid-state",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An error of the format or crypto layer. Each variant is one code of [`ErrorCode`] with a short detail.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// See [`ErrorCode::WrongSecret`].
    #[error("wrong-secret: {0}")]
    WrongSecret(&'static str),
    /// See [`ErrorCode::UnsupportedKeyslot`].
    #[error("unsupported-keyslot: {0}")]
    UnsupportedKeyslot(&'static str),
    /// See [`ErrorCode::UnsupportedFormat`].
    #[error("unsupported-format: {0}")]
    UnsupportedFormat(&'static str),
    /// See [`ErrorCode::Corrupt`].
    #[error("corrupt: {0}")]
    Corrupt(&'static str),
    /// See [`ErrorCode::Tampered`].
    #[error("tampered: {0}")]
    Tampered(&'static str),
    /// See [`ErrorCode::Locked`].
    #[error("locked: {0}")]
    Locked(&'static str),
    /// See [`ErrorCode::InvalidInput`].
    #[error("invalid-input: {0}")]
    InvalidInput(&'static str),
    /// See [`ErrorCode::InvalidState`].
    #[error("invalid-state: {0}")]
    InvalidState(&'static str),
}

impl Error {
    /// The stable code of this error.
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::WrongSecret(_) => ErrorCode::WrongSecret,
            Self::UnsupportedKeyslot(_) => ErrorCode::UnsupportedKeyslot,
            Self::UnsupportedFormat(_) => ErrorCode::UnsupportedFormat,
            Self::Corrupt(_) => ErrorCode::Corrupt,
            Self::Tampered(_) => ErrorCode::Tampered,
            Self::Locked(_) => ErrorCode::Locked,
            Self::InvalidInput(_) => ErrorCode::InvalidInput,
            Self::InvalidState(_) => ErrorCode::InvalidState,
        }
    }
}

/// The result type of the format and crypto layers.
pub type Result<T, E = Error> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::{Error, ErrorCode};

    #[test]
    fn codes_are_the_spec_strings() {
        let all = [
            (Error::WrongSecret("x"), "wrong-secret"),
            (Error::UnsupportedKeyslot("x"), "unsupported-keyslot"),
            (Error::UnsupportedFormat("x"), "unsupported-format"),
            (Error::Corrupt("x"), "corrupt"),
            (Error::Tampered("x"), "tampered"),
            (Error::Locked("x"), "locked"),
            (Error::InvalidInput("x"), "invalid-input"),
            (Error::InvalidState("x"), "invalid-state"),
        ];
        for (error, code) in all {
            assert_eq!(error.code().as_str(), code);
            assert_eq!(error.to_string(), format!("{code}: x"));
        }
        assert_eq!(ErrorCode::Corrupt.to_string(), "corrupt");
    }
}
