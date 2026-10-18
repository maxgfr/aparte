//! Errors of the sync layer: a format or crypto error (spec/FORMAT.md section 12), a device store failure, or a sync
//! store that refused or failed (the kinds of web/src/core/contracts/sync.ts `RemoteErrorKind`).

use aparte_format::ErrorCode;

/// Why a sync store refused or failed, as the engine branches on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RemoteErrorKind {
    /// The credentials are wrong or expired.
    Auth,
    /// The credentials are valid but may not do this (a read-only token).
    Permission,
    /// The repository, bucket or folder does not exist, or holds no vault yet.
    NotFound,
    /// No answer, a reset connection, a 5xx, a `git` that failed to reach the remote: retried later.
    Network,
    /// The store is full or refuses the size.
    Quota,
    /// Too many requests: retried after a while.
    RateLimited,
    /// The device clock is too far from the server's (S3 signatures).
    ClockSkew,
    /// The store holds something this build does not read (another format, another vault).
    Incompatible,
}

impl RemoteErrorKind {
    /// The kind as the web contract spells it.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Permission => "permission",
            Self::NotFound => "not-found",
            Self::Network => "network",
            Self::Quota => "quota",
            Self::RateLimited => "rate-limited",
            Self::ClockSkew => "clock-skew",
            Self::Incompatible => "incompatible",
        }
    }
}

/// A sync store refused or failed. The message never carries a credential.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}: {message}", kind.as_str())]
pub struct RemoteError {
    /// What went wrong.
    pub kind: RemoteErrorKind,
    /// A detail for the user and the logs.
    pub message: String,
    /// How long the store asked to wait, when it said so.
    pub retry_after_ms: Option<u64>,
}

impl RemoteError {
    /// A store error of `kind`.
    pub fn new(kind: RemoteErrorKind, message: impl Into<String>) -> RemoteError {
        RemoteError {
            kind,
            message: message.into(),
            retry_after_ms: None,
        }
    }

    /// The same error, with a wait the store asked for.
    pub fn retry_after(mut self, ms: u64) -> RemoteError {
        self.retry_after_ms = Some(ms);
        self
    }
}

/// An error of the sync layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A format or crypto error.
    #[error(transparent)]
    Format(#[from] aparte_format::Error),
    /// The device store failed.
    #[error(transparent)]
    Store(#[from] aparte_store::Error),
    /// A sync store refused or failed.
    #[error(transparent)]
    Remote(#[from] RemoteError),
}

impl Error {
    /// The format code of a format error (also inside a store error), else `None`.
    pub fn format_code(&self) -> Option<ErrorCode> {
        match self {
            Self::Format(e) => Some(e.code()),
            Self::Store(e) => e.code(),
            Self::Remote(_) => None,
        }
    }

    /// The store error kind of a remote failure, else `None`.
    pub fn remote_kind(&self) -> Option<RemoteErrorKind> {
        match self {
            Self::Remote(e) => Some(e.kind),
            _ => None,
        }
    }
}

/// The result type of the sync layer.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A `corrupt` format error.
pub fn corrupt(detail: &'static str) -> Error {
    aparte_format::Error::Corrupt(detail).into()
}

/// An `invalid-input` format error.
pub fn invalid(detail: &'static str) -> Error {
    aparte_format::Error::InvalidInput(detail).into()
}

/// An `invalid-state` format error.
pub fn invalid_state(detail: &'static str) -> Error {
    aparte_format::Error::InvalidState(detail).into()
}

/// A remote error of `kind`.
pub fn remote(kind: RemoteErrorKind, message: impl Into<String>) -> Error {
    RemoteError::new(kind, message).into()
}
