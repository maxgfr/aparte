//! Randomness is injected everywhere it is drawn, so the vectors are reproducible with a [`QueueRng`] while
//! production draws from the operating system through [`OsRng`].

use std::collections::VecDeque;

use crate::{Error, Result};

/// A source of random bytes.
pub trait Rng {
    /// Fills `dest` with fresh bytes.
    fn fill(&mut self, dest: &mut [u8]) -> Result<()>;
}

/// Draws `N` fresh bytes from `rng`.
pub fn draw<const N: usize>(rng: &mut dyn Rng) -> Result<[u8; N]> {
    let mut out = [0u8; N];
    rng.fill(&mut out)?;
    Ok(out)
}

/// The operating system's CSPRNG.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsRng;

impl Rng for OsRng {
    fn fill(&mut self, dest: &mut [u8]) -> Result<()> {
        getrandom::fill(dest).map_err(|_| Error::InvalidState("the system random source is unavailable"))
    }
}

/// An RNG that hands out a fixed list of values, for the vectors. A draw whose length differs from the next
/// value, or a draw past the end, is `invalid-state`: a vector that consumes randomness in another order than
/// spec/FORMAT.md sections 6.6 and 7.6 fix fails loudly instead of producing other bytes.
#[derive(Debug, Clone, Default)]
pub struct QueueRng {
    values: VecDeque<Vec<u8>>,
}

impl QueueRng {
    /// A queue of `values`, handed out in order.
    pub fn new<I, V>(values: I) -> Self
    where
        I: IntoIterator<Item = V>,
        V: Into<Vec<u8>>,
    {
        Self {
            values: values.into_iter().map(Into::into).collect(),
        }
    }

    /// The values not drawn yet.
    pub fn remaining(&self) -> usize {
        self.values.len()
    }
}

impl Rng for QueueRng {
    fn fill(&mut self, dest: &mut [u8]) -> Result<()> {
        match self.values.front() {
            Some(next) if next.len() == dest.len() => {
                dest.copy_from_slice(next);
                self.values.pop_front();
                Ok(())
            }
            Some(_) => Err(Error::InvalidState("queued random value of another length")),
            None => Err(Error::InvalidState("random queue exhausted")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_hands_out_values_in_order_and_fails_loudly() {
        let mut rng = QueueRng::new([vec![1u8; 2], vec![2u8; 3]]);
        assert_eq!(draw::<2>(&mut rng).unwrap(), [1, 1]);
        assert_eq!(rng.remaining(), 1);
        assert_eq!(draw::<2>(&mut rng).unwrap_err().code().as_str(), "invalid-state");
        assert_eq!(rng.remaining(), 1);
        assert_eq!(draw::<3>(&mut rng).unwrap(), [2, 2, 2]);
        assert_eq!(draw::<1>(&mut rng).unwrap_err().code().as_str(), "invalid-state");
    }

    #[test]
    fn os_rng_draws_fresh_bytes() {
        let a = draw::<32>(&mut OsRng).unwrap();
        let b = draw::<32>(&mut OsRng).unwrap();
        assert_ne!(a, b);
    }
}
