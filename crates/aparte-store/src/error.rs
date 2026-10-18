//! Errors of the device store: a format or crypto error with its stable code (spec/FORMAT.md section 12), or a file
//! system failure.

use aparte_format::ErrorCode;

/// An error of the store or the vault.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A format or crypto error; [`Error::code`] gives its code.
    #[error(transparent)]
    Format(#[from] aparte_format::Error),
    /// Reading or writing a file failed.
    #[error("{context}: {source}")]
    Io {
        /// What was being done.
        context: String,
        /// The underlying error.
        #[source]
        source: std::io::Error,
    },
}

impl Error {
    /// The format code, or `None` for a file system failure.
    pub fn code(&self) -> Option<ErrorCode> {
        match self {
            Self::Format(e) => Some(e.code()),
            Self::Io { .. } => None,
        }
    }

    /// An I/O error with what was being done.
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }
}

/// The result type of the store.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Adds a context to an I/O result.
pub(crate) trait IoContext<T> {
    fn ctx(self, context: impl FnOnce() -> String) -> Result<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn ctx(self, context: impl FnOnce() -> String) -> Result<T> {
        self.map_err(|e| Error::io(context(), e))
    }
}
