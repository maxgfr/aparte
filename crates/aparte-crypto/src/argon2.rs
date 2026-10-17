//! Argon2id version `0x13` (RFC 9106), the passphrase function of spec/FORMAT.md section 6.4.
//!
//! The format never uses the optional secret or associated data; they are exposed so the RFC 9106 known answer can
//! be checked as published. No vault bound is enforced here: the keyslot layer checks the bounds before calling,
//! so a hostile slot never reaches this function.

use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};
use zeroize::Zeroizing;

use crate::{Error, Result};

/// The inputs of one Argon2id run.
#[derive(Clone, Copy)]
pub struct Argon2Input<'a> {
    /// The password `P`.
    pub password: &'a [u8],
    /// The salt `S`.
    pub salt: &'a [u8],
    /// Memory in KiB.
    pub m: u32,
    /// Passes.
    pub t: u32,
    /// Lanes.
    pub p: u32,
    /// Tag length in bytes.
    pub length: usize,
    /// The optional secret `K`; empty in the format.
    pub secret: &'a [u8],
    /// The optional associated data `X`; empty in the format.
    pub ad: &'a [u8],
}

impl std::fmt::Debug for Argon2Input<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Argon2Input")
            .field("m", &self.m)
            .field("t", &self.t)
            .field("p", &self.p)
            .field("length", &self.length)
            .finish_non_exhaustive()
    }
}

/// An Argon2id implementation, injectable so a caller can count runs or move them off the current thread.
pub type Argon2Fn<'a> = &'a dyn Fn(&Argon2Input<'_>) -> Result<Zeroizing<Vec<u8>>>;

/// Argon2id `0x13`; `invalid-input` for parameters the algorithm itself rejects.
pub fn argon2id(input: &Argon2Input<'_>) -> Result<Zeroizing<Vec<u8>>> {
    let invalid = |_| Error::InvalidInput("Argon2 parameters");
    let mut builder = ParamsBuilder::new();
    builder
        .m_cost(input.m)
        .t_cost(input.t)
        .p_cost(input.p)
        .output_len(input.length);
    if !input.ad.is_empty() {
        builder.data(AssociatedData::new(input.ad).map_err(invalid)?);
    }
    let params = builder.build().map_err(invalid)?;
    let context = if input.secret.is_empty() {
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
    } else {
        Argon2::new_with_secret(input.secret, Algorithm::Argon2id, Version::V0x13, params).map_err(invalid)?
    };
    let mut out = Zeroizing::new(vec![0u8; input.length]);
    context
        .hash_password_into(input.password, input.salt, &mut out)
        .map_err(invalid)?;
    Ok(out)
}
