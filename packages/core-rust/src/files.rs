//! Chunked content encryption for file attachments. See docs/file-attachments.md.
//!
//! A file uses the same envelope as an entry: a per-file FEK, wrapped under the VEK exactly as
//! an entry's DEK is. Two differences, and both come from size rather than from any change to
//! the model:
//!
//! 1. Content is sealed in fixed-size chunks, each with its own tag. AES-GCM is all-or-nothing,
//!    so a single-shot seal cannot be verified without buffering the whole file, cannot stream
//!    to a download, and cannot show page 1 of a PDF without decrypting all of it.
//! 2. The sealed chunks live outside the vault blob, addressed by the hash of their own
//!    ciphertext, because anything inside the vault blob is rewritten on every entry edit and
//!    rebroadcast to every peer every four seconds.
//!
//! Chunking naively is where this goes wrong, so the nonce is the STREAM construction
//! (Hoang-Reyhanitabar-Rogaway-Vizar, as used by age and Tink) rather than anything invented
//! here: `prefix(7) || index BE(4) || final(1)`. The counter stops chunks being reordered or
//! duplicated, the final flag stops the file being truncated, and the per-file random prefix
//! stops a chunk being spliced in from another file. Each of those is covered by a test below,
//! because each is a silent corruption rather than a loud failure if it regresses.
//!
//! This module is deliberately VEK-free and binding-free. It takes a FEK as a parameter, so it
//! neither reads nor disturbs the global VEK slot (the property `portable_vault` is tested for)
//! and its tests need no `VEK_SLOT_LOCK`. The binding layers come later and will be
//! handle-based rather than buffer-based: a 100 MB file must not be marshalled through
//! `chrome.runtime.sendMessage` or the Capacitor bridge 400 times.

use std::fs::File;
use std::io::{BufReader, BufWriter, ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::Path;

use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{aes_decrypt, aes_encrypt, err, random_bytes, CryptoError, IV_LEN, KEY_LEN};

/// Plaintext bytes per sealed chunk. Large enough that the per-chunk tag overhead is noise
/// (0.006%), small enough to decrypt one chunk for a preview without a large allocation.
pub const CHUNK_LEN: usize = 256 * 1024;
/// The AES-GCM tag appended to each sealed chunk.
pub const TAG_LEN: usize = 16;
/// Per-file random nonce prefix. 7 + 4 + 1 == IV_LEN.
pub const NONCE_PREFIX_LEN: usize = 7;

// New separators, so unlike WEBAUTHN_KDF_INFO these name the product as it is now. They are
// frozen from first release for the same reason: they are inputs to the KDF, not labels.
const META_KDF_INFO: &[u8] = b"bramble/file/meta/v1";
const CONTENT_KDF_INFO: &[u8] = b"bramble/file/content/v1";

/// The two subkeys a file's FEK expands into.
///
/// Separate keys because the metadata is one small seal under a random IV while the content
/// uses structured STREAM nonces. Under a single key a random IV could collide with a chunk
/// nonce, and nonce reuse is the one failure AES-GCM does not survive. Two subkeys cost one
/// HKDF each and make the question not arise; only the FEK is stored.
pub struct FileSubkeys {
    pub meta: Zeroizing<[u8; KEY_LEN]>,
    pub content: Zeroizing<[u8; KEY_LEN]>,
}

/// Expand a file's FEK into its metadata and content subkeys.
pub fn derive_file_subkeys(fek: &[u8]) -> Result<FileSubkeys, CryptoError> {
    if fek.len() != KEY_LEN {
        return Err(err("fek must be 32 bytes"));
    }
    let hkdf = Hkdf::<Sha256>::new(None, fek);
    let mut meta = Zeroizing::new([0u8; KEY_LEN]);
    let mut content = Zeroizing::new([0u8; KEY_LEN]);
    hkdf.expand(META_KDF_INFO, meta.as_mut_slice())
        .map_err(|e| err(format!("hkdf expand: {e}")))?;
    hkdf.expand(CONTENT_KDF_INFO, content.as_mut_slice())
        .map_err(|e| err(format!("hkdf expand: {e}")))?;
    Ok(FileSubkeys { meta, content })
}

/// A fresh random nonce prefix for one file.
pub fn generate_nonce_prefix() -> Result<[u8; NONCE_PREFIX_LEN], CryptoError> {
    let mut prefix = [0u8; NONCE_PREFIX_LEN];
    random_bytes(&mut prefix)?;
    Ok(prefix)
}

/// The STREAM nonce for one chunk: `prefix(7) || index BE(4) || final(1)`.
fn chunk_nonce(prefix: &[u8; NONCE_PREFIX_LEN], index: u32, is_last: bool) -> [u8; IV_LEN] {
    let mut nonce = [0u8; IV_LEN];
    nonce[..NONCE_PREFIX_LEN].copy_from_slice(prefix);
    nonce[NONCE_PREFIX_LEN..NONCE_PREFIX_LEN + 4].copy_from_slice(&index.to_be_bytes());
    nonce[IV_LEN - 1] = u8::from(is_last);
    nonce
}

/// Seal one chunk. `is_last` is part of the nonce, so a chunk sealed as interior can never be
/// opened as final: that is what makes truncating a file a decrypt failure.
pub fn seal_chunk(
    content_key: &[u8],
    prefix: &[u8; NONCE_PREFIX_LEN],
    index: u32,
    is_last: bool,
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if plaintext.len() > CHUNK_LEN {
        return Err(err("chunk plaintext exceeds CHUNK_LEN"));
    }
    aes_encrypt(content_key, &chunk_nonce(prefix, index, is_last), plaintext)
}

/// Open one chunk. Fails if the index or the final flag differs from the one it was sealed with.
pub fn open_chunk(
    content_key: &[u8],
    prefix: &[u8; NONCE_PREFIX_LEN],
    index: u32,
    is_last: bool,
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    aes_decrypt(
        content_key,
        &chunk_nonce(prefix, index, is_last),
        ciphertext,
    )
}

/// Sealed chunks for a plaintext of this length. Always at least one, so every blob ends with a
/// final-flagged chunk and the truncation guard holds even for an empty file.
pub fn chunk_count(plaintext_len: u64) -> u64 {
    if plaintext_len == 0 {
        return 1;
    }
    plaintext_len.div_ceil(CHUNK_LEN as u64)
}

/// Total sealed length: the plaintext plus one tag per chunk.
pub fn sealed_len(plaintext_len: u64) -> u64 {
    plaintext_len + chunk_count(plaintext_len) * TAG_LEN as u64
}

/// Byte offset of sealed chunk `index` within the blob. Every chunk but the last is exactly
/// `CHUNK_LEN + TAG_LEN`, so random access for a preview is a seek and the blob needs no
/// stored chunk index.
pub fn chunk_offset(index: u64) -> u64 {
    index * (CHUNK_LEN + TAG_LEN) as u64
}

/// Recover the chunk count from a sealed blob's length. The reachable lengths for N chunks and
/// N+1 chunks do not overlap, so this is unambiguous.
pub fn chunk_count_from_sealed(sealed_len: u64) -> Result<u64, CryptoError> {
    if sealed_len < TAG_LEN as u64 {
        return Err(err("sealed blob is shorter than one tag"));
    }
    Ok(sealed_len.div_ceil((CHUNK_LEN + TAG_LEN) as u64).max(1))
}

/// Seal a whole buffer. For small payloads and for tests; a real attachment is sealed chunk by
/// chunk from a file handle so the plaintext is never fully resident.
pub fn seal_file(
    content_key: &[u8],
    prefix: &[u8; NONCE_PREFIX_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let count = chunk_count(plaintext.len() as u64);
    let mut out = Vec::with_capacity(sealed_len(plaintext.len() as u64) as usize);
    for index in 0..count {
        let index_u32 = u32::try_from(index).map_err(|_| err("chunk index exceeds u32"))?;
        let start = index as usize * CHUNK_LEN;
        let end = plaintext.len().min(start + CHUNK_LEN);
        out.extend_from_slice(&seal_chunk(
            content_key,
            prefix,
            index_u32,
            index + 1 == count,
            &plaintext[start..end],
        )?);
    }
    Ok(out)
}

/// Open a whole sealed buffer. The inverse of `seal_file`.
pub fn open_file(
    content_key: &[u8],
    prefix: &[u8; NONCE_PREFIX_LEN],
    sealed: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let count = chunk_count_from_sealed(sealed.len() as u64)?;
    let mut out = Zeroizing::new(Vec::new());
    for index in 0..count {
        let index_u32 = u32::try_from(index).map_err(|_| err("chunk index exceeds u32"))?;
        let start = chunk_offset(index) as usize;
        let is_last = index + 1 == count;
        let end = if is_last {
            sealed.len()
        } else {
            start + CHUNK_LEN + TAG_LEN
        };
        if end > sealed.len() || end <= start {
            return Err(err("sealed blob is truncated"));
        }
        out.extend_from_slice(&open_chunk(
            content_key,
            prefix,
            index_u32,
            is_last,
            &sealed[start..end],
        )?);
    }
    Ok(out)
}

/// Streaming SHA-256 over a blob's SEALED bytes: the blob's address, and what a receiver checks
/// to know it got what the manifest named.
///
/// Streaming rather than one-shot because the alternative is holding a whole attachment in
/// memory to hash it. WebCrypto has no incremental digest, which is why this lives here rather
/// than in TypeScript. It is also what lets an interrupted transfer resume: rehash the staged
/// prefix, then keep going, instead of refetching from zero.
pub struct BlobHasher {
    inner: Sha256,
}

impl Default for BlobHasher {
    fn default() -> Self {
        Self::new()
    }
}

impl BlobHasher {
    pub fn new() -> Self {
        Self {
            inner: Sha256::new(),
        }
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.inner.update(bytes);
    }

    /// Lowercase hex, matching `FileRecord.hash` and the blob's key in the store.
    pub fn finish(self) -> String {
        let digest = self.inner.finalize();
        let mut out = String::with_capacity(digest.len() * 2);
        for byte in digest {
            out.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
            out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
        }
        out
    }
}

/// One-shot blob hash, for a payload already in memory.
pub fn blob_hash(bytes: &[u8]) -> String {
    let mut hasher = BlobHasher::new();
    hasher.update(bytes);
    hasher.finish()
}

/// Map an io error without naming the path. A filename is sealed metadata in this design, and
/// error strings reach logs, so the kind is all that travels.
fn io_err(context: &str, e: std::io::Error) -> CryptoError {
    err(format!("{context}: {}", e.kind()))
}

/// Fill `buf` as far as the reader allows. Short only at EOF: a single `read` is free to return
/// fewer bytes than asked for, and treating that as EOF would silently truncate a file.
fn read_up_to(reader: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// What sealing a file produced.
///
/// The wrapped FEK is deliberately NOT here: this module never touches the VEK slot, so
/// wrapping the key belongs to the caller in lib.rs that owns it.
#[derive(Debug, Clone)]
pub struct SealedFileContent {
    /// Lowercase hex SHA-256 of the sealed blob: its address in the store.
    pub hash: String,
    /// Sealed blob length.
    pub size: u64,
    /// Plaintext length, for the sealed metadata.
    pub plaintext_size: u64,
    pub chunk_count: u64,
    pub nonce_prefix: [u8; NONCE_PREFIX_LEN],
}

/// Seal `src` into `dst`, one chunk at a time.
///
/// This is the native half of "the crypto call must be handle-based": it takes paths, so a
/// 100 MB attachment is never marshalled across the uniffi bridge, and never more than two
/// chunks are resident whatever the file's size.
///
/// `dst` must be a STAGING path, not the final blob name. A blob is addressed by the hash of
/// its own ciphertext, which is not known until the last chunk is written, so the caller
/// renames to `blobs/<hash>` once this returns. That is the same publish-after-verify
/// discipline BlobStore applies on the TypeScript side.
pub fn seal_file_at_path(
    content_key: &[u8],
    src: &Path,
    dst: &Path,
) -> Result<SealedFileContent, CryptoError> {
    let nonce_prefix = generate_nonce_prefix()?;
    let mut reader = BufReader::new(File::open(src).map_err(|e| io_err("open source", e))?);
    let mut writer = BufWriter::new(File::create(dst).map_err(|e| io_err("create staging", e))?);
    let mut hasher = BlobHasher::new();

    let mut current = vec![0u8; CHUNK_LEN];
    let mut lookahead = vec![0u8; CHUNK_LEN];
    let mut current_len = read_up_to(&mut reader, &mut current).map_err(|e| io_err("read", e))?;
    let mut index: u32 = 0;
    let mut plaintext_size: u64 = 0;
    let mut size: u64 = 0;

    loop {
        // Read one chunk ahead to learn whether this one is final, rather than deriving it from
        // the file's reported length: the length can change under us mid-read, and the final
        // flag is exactly what makes a truncated file fail to open.
        let ahead = read_up_to(&mut reader, &mut lookahead).map_err(|e| io_err("read", e))?;
        let is_last = ahead == 0;
        let sealed = seal_chunk(
            content_key,
            &nonce_prefix,
            index,
            is_last,
            &current[..current_len],
        )?;
        hasher.update(&sealed);
        writer
            .write_all(&sealed)
            .map_err(|e| io_err("write staging", e))?;
        plaintext_size += current_len as u64;
        size += sealed.len() as u64;
        if is_last {
            break;
        }
        std::mem::swap(&mut current, &mut lookahead);
        current_len = ahead;
        index = index
            .checked_add(1)
            .ok_or_else(|| err("file exceeds the chunk counter"))?;
    }
    writer.flush().map_err(|e| io_err("flush staging", e))?;

    Ok(SealedFileContent {
        hash: hasher.finish(),
        size,
        plaintext_size,
        chunk_count: u64::from(index) + 1,
        nonce_prefix,
    })
}

/// Chunk count implied by a sealed blob on disk.
fn chunks_on_disk(src: &Path) -> Result<(u64, u64), CryptoError> {
    let len = std::fs::metadata(src)
        .map_err(|e| io_err("stat blob", e))?
        .len();
    Ok((len, chunk_count_from_sealed(len)?))
}

/// Decrypt a whole sealed blob back to `dst`, one chunk at a time. Returns the plaintext length.
pub fn open_file_at_path(
    content_key: &[u8],
    nonce_prefix: &[u8; NONCE_PREFIX_LEN],
    src: &Path,
    dst: &Path,
) -> Result<u64, CryptoError> {
    let (sealed_len, count) = chunks_on_disk(src)?;
    let mut reader = BufReader::new(File::open(src).map_err(|e| io_err("open blob", e))?);
    let mut writer = BufWriter::new(File::create(dst).map_err(|e| io_err("create output", e))?);
    let mut buf = vec![0u8; CHUNK_LEN + TAG_LEN];
    let mut written = 0u64;

    for index in 0..count {
        let is_last = index + 1 == count;
        let want = if is_last {
            (sealed_len - chunk_offset(index)) as usize
        } else {
            CHUNK_LEN + TAG_LEN
        };
        let got = read_up_to(&mut reader, &mut buf[..want]).map_err(|e| io_err("read blob", e))?;
        if got != want {
            return Err(err("blob is shorter than its length reported"));
        }
        let index32 = u32::try_from(index).map_err(|_| err("chunk index exceeds u32"))?;
        let plain = open_chunk(content_key, nonce_prefix, index32, is_last, &buf[..want])?;
        writer
            .write_all(&plain)
            .map_err(|e| io_err("write output", e))?;
        written += plain.len() as u64;
    }
    writer.flush().map_err(|e| io_err("flush output", e))?;
    Ok(written)
}

/// Open ONE chunk of a sealed blob, by index.
///
/// This is what makes the chunking pay for itself at the UI: showing the first page of a 100 MB
/// PDF decrypts 256 KiB and seeks, rather than decrypting 100 MB. Chunk `i` is at a computable
/// offset because every chunk but the last is exactly `CHUNK_LEN + TAG_LEN`.
pub fn open_file_chunk_at_path(
    content_key: &[u8],
    nonce_prefix: &[u8; NONCE_PREFIX_LEN],
    src: &Path,
    index: u64,
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let (sealed_len, count) = chunks_on_disk(src)?;
    if index >= count {
        return Err(err("chunk index past the end of the blob"));
    }
    let is_last = index + 1 == count;
    let offset = chunk_offset(index);
    let want = if is_last {
        (sealed_len - offset) as usize
    } else {
        CHUNK_LEN + TAG_LEN
    };
    let mut file = File::open(src).map_err(|e| io_err("open blob", e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| io_err("seek blob", e))?;
    let mut buf = vec![0u8; want];
    let got = read_up_to(&mut file, &mut buf).map_err(|e| io_err("read blob", e))?;
    if got != want {
        return Err(err("blob is shorter than its length reported"));
    }
    let index32 = u32::try_from(index).map_err(|_| err("chunk index exceeds u32"))?;
    open_chunk(content_key, nonce_prefix, index32, is_last, &buf)
}

/// Seals a file one chunk at a time as the caller hands them over, for a binding with no
/// filesystem to stream from (the extension, whose bytes live in IndexedDB).
///
/// The caller reads the chunks and says which is last. That is safe there, unlike on a path,
/// because what it reads from is an immutable Blob whose length cannot change mid-read. What
/// this still enforces is the layout: every chunk but the last is exactly CHUNK_LEN, and only an
/// empty file ends in an empty chunk, so a streamed blob is byte-for-byte the shape
/// `seal_file_at_path` produces and every reader's offset arithmetic holds.
pub struct SealStream {
    content_key: Zeroizing<[u8; KEY_LEN]>,
    nonce_prefix: [u8; NONCE_PREFIX_LEN],
    hasher: BlobHasher,
    index: u32,
    size: u64,
    plaintext_size: u64,
    sealed_last: bool,
}

impl SealStream {
    pub fn new(content_key: &[u8]) -> Result<Self, CryptoError> {
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        if content_key.len() != KEY_LEN {
            return Err(err("content key must be 32 bytes"));
        }
        key.copy_from_slice(content_key);
        Ok(Self {
            content_key: key,
            nonce_prefix: generate_nonce_prefix()?,
            hasher: BlobHasher::new(),
            index: 0,
            size: 0,
            plaintext_size: 0,
            sealed_last: false,
        })
    }

    /// Seal the next chunk, returning its sealed bytes for the caller to store.
    pub fn seal_next(&mut self, plaintext: &[u8], is_last: bool) -> Result<Vec<u8>, CryptoError> {
        if self.sealed_last {
            return Err(err("the final chunk is already sealed"));
        }
        if !is_last && plaintext.len() != CHUNK_LEN {
            return Err(err("every chunk but the last must be exactly CHUNK_LEN"));
        }
        if plaintext.len() > CHUNK_LEN {
            return Err(err("chunk plaintext exceeds CHUNK_LEN"));
        }
        if is_last && plaintext.is_empty() && self.index > 0 {
            return Err(err("only an empty file ends in an empty chunk"));
        }
        let sealed = seal_chunk(
            self.content_key.as_slice(),
            &self.nonce_prefix,
            self.index,
            is_last,
            plaintext,
        )?;
        self.hasher.update(&sealed);
        self.size += sealed.len() as u64;
        self.plaintext_size += plaintext.len() as u64;
        if is_last {
            self.sealed_last = true;
        } else {
            self.index = self
                .index
                .checked_add(1)
                .ok_or_else(|| err("file exceeds the chunk counter"))?;
        }
        Ok(sealed)
    }

    /// The blob's address and shape. Fails until the final chunk is sealed, since a blob
    /// without one cannot be opened.
    pub fn finish(self) -> Result<SealedFileContent, CryptoError> {
        if !self.sealed_last {
            return Err(err("the file has no final chunk"));
        }
        Ok(SealedFileContent {
            hash: self.hasher.finish(),
            size: self.size,
            plaintext_size: self.plaintext_size,
            chunk_count: u64::from(self.index) + 1,
            nonce_prefix: self.nonce_prefix,
        })
    }
}

/// Opens a sealed blob one chunk at a time, in order, as the caller reads them. The inverse of
/// `SealStream`, and for the same binding.
///
/// The chunk count comes from the blob's length, so the caller only has to supply the bytes;
/// a blob cut short opens up to the cut and then fails on the final flag.
pub struct OpenStream {
    content_key: Zeroizing<[u8; KEY_LEN]>,
    nonce_prefix: [u8; NONCE_PREFIX_LEN],
    sealed_len: u64,
    count: u64,
    index: u64,
}

impl OpenStream {
    pub fn new(
        content_key: &[u8],
        nonce_prefix: &[u8; NONCE_PREFIX_LEN],
        sealed_len: u64,
    ) -> Result<Self, CryptoError> {
        if content_key.len() != KEY_LEN {
            return Err(err("content key must be 32 bytes"));
        }
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        key.copy_from_slice(content_key);
        Ok(Self {
            content_key: key,
            nonce_prefix: *nonce_prefix,
            sealed_len,
            count: chunk_count_from_sealed(sealed_len)?,
            index: 0,
        })
    }

    /// The file's length once open: the sealed length less one tag per chunk.
    pub fn plaintext_len(&self) -> u64 {
        self.sealed_len - self.count * TAG_LEN as u64
    }

    /// Where the next chunk starts in the blob and how long it is, or None once all are open.
    pub fn next_range(&self) -> Option<(u64, u64)> {
        if self.index >= self.count {
            return None;
        }
        let offset = chunk_offset(self.index);
        let len = if self.index + 1 == self.count {
            self.sealed_len - offset
        } else {
            (CHUNK_LEN + TAG_LEN) as u64
        };
        Some((offset, len))
    }

    /// Open the next chunk. `sealed` must be exactly the range `next_range` named.
    pub fn open_next(&mut self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
        let (_, want) = self
            .next_range()
            .ok_or_else(|| err("every chunk is already open"))?;
        if sealed.len() as u64 != want {
            return Err(err("chunk is not the length the blob implies"));
        }
        let index32 = u32::try_from(self.index).map_err(|_| err("chunk index exceeds u32"))?;
        let plain = open_chunk(
            self.content_key.as_slice(),
            &self.nonce_prefix,
            index32,
            self.index + 1 == self.count,
            sealed,
        )?;
        self.index += 1;
        Ok(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEK: [u8; KEY_LEN] = [0x42; KEY_LEN];
    const PREFIX: [u8; NONCE_PREFIX_LEN] = [0x11; NONCE_PREFIX_LEN];

    fn content_key() -> Zeroizing<[u8; KEY_LEN]> {
        derive_file_subkeys(&FEK).unwrap().content
    }

    fn body(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn round_trips_every_chunk_boundary() {
        let key = content_key();
        // Empty, sub-chunk, exactly one chunk, one byte over, and a multi-chunk file. The
        // boundaries are where an off-by-one produces a spurious empty final chunk.
        for len in [0, 1, CHUNK_LEN - 1, CHUNK_LEN, CHUNK_LEN + 1, 3 * CHUNK_LEN] {
            let plaintext = body(len);
            let sealed = seal_file(key.as_slice(), &PREFIX, &plaintext).unwrap();
            assert_eq!(
                sealed.len() as u64,
                sealed_len(len as u64),
                "sealed len for {len}"
            );
            assert_eq!(
                chunk_count_from_sealed(sealed.len() as u64).unwrap(),
                chunk_count(len as u64),
                "recovered chunk count for {len}"
            );
            assert_eq!(
                open_file(key.as_slice(), &PREFIX, &sealed)
                    .unwrap()
                    .as_slice(),
                plaintext.as_slice(),
                "round trip for {len}"
            );
        }
    }

    #[test]
    fn layout_helpers_are_exact() {
        assert_eq!(chunk_count(0), 1); // an empty file still gets a final-flagged chunk
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(CHUNK_LEN as u64), 1);
        assert_eq!(chunk_count(CHUNK_LEN as u64 + 1), 2);
        assert_eq!(chunk_count(2 * CHUNK_LEN as u64), 2);
        assert_eq!(sealed_len(0), TAG_LEN as u64);
        assert_eq!(sealed_len(CHUNK_LEN as u64), (CHUNK_LEN + TAG_LEN) as u64);
        assert_eq!(chunk_offset(0), 0);
        assert_eq!(chunk_offset(2), 2 * (CHUNK_LEN + TAG_LEN) as u64);
        assert!(chunk_count_from_sealed(TAG_LEN as u64 - 1).is_err());
    }

    #[test]
    fn subkeys_are_distinct_deterministic_and_fek_bound() {
        let a = derive_file_subkeys(&FEK).unwrap();
        let b = derive_file_subkeys(&FEK).unwrap();
        assert_eq!(a.meta.as_slice(), b.meta.as_slice());
        assert_eq!(a.content.as_slice(), b.content.as_slice());
        // The whole point of two subkeys: the metadata key must never equal the content key.
        assert_ne!(a.meta.as_slice(), a.content.as_slice());
        let other = derive_file_subkeys(&[0x43; KEY_LEN]).unwrap();
        assert_ne!(a.content.as_slice(), other.content.as_slice());
        assert!(derive_file_subkeys(&[0u8; 16]).is_err());
    }

    // --- the three attacks the nonce layout exists to stop ---

    #[test]
    fn a_reordered_chunk_does_not_open() {
        let key = content_key();
        let sealed = seal_chunk(key.as_slice(), &PREFIX, 5, false, &body(64)).unwrap();
        assert!(open_chunk(key.as_slice(), &PREFIX, 5, false, &sealed).is_ok());
        assert!(open_chunk(key.as_slice(), &PREFIX, 9, false, &sealed).is_err());
    }

    #[test]
    fn a_truncated_file_does_not_open() {
        let key = content_key();
        let plaintext = body(3 * CHUNK_LEN);
        let sealed = seal_file(key.as_slice(), &PREFIX, &plaintext).unwrap();
        // Lop off the final chunk. The new last chunk was sealed as interior, so opening it as
        // final fails: truncation is a decrypt error, not a silently shorter file.
        let short = &sealed[..2 * (CHUNK_LEN + TAG_LEN)];
        assert!(open_file(key.as_slice(), &PREFIX, short).is_err());
    }

    #[test]
    fn a_chunk_from_another_file_does_not_splice_in() {
        let key = content_key();
        let other_prefix = [0x22; NONCE_PREFIX_LEN];
        let sealed = seal_chunk(key.as_slice(), &other_prefix, 0, true, &body(64)).unwrap();
        // Same key, same index, same flag, different file: the prefix alone rejects it.
        assert!(open_chunk(key.as_slice(), &PREFIX, 0, true, &sealed).is_err());
    }

    #[test]
    fn a_tampered_chunk_does_not_open() {
        let key = content_key();
        let mut sealed = seal_chunk(key.as_slice(), &PREFIX, 0, true, &body(64)).unwrap();
        sealed[3] ^= 0x01;
        assert!(open_chunk(key.as_slice(), &PREFIX, 0, true, &sealed).is_err());
    }

    #[test]
    fn the_wrong_fek_does_not_open() {
        let sealed = seal_file(content_key().as_slice(), &PREFIX, &body(1024)).unwrap();
        let wrong = derive_file_subkeys(&[0x43; KEY_LEN]).unwrap().content;
        assert!(open_file(wrong.as_slice(), &PREFIX, &sealed).is_err());
    }

    #[test]
    fn an_oversized_chunk_is_refused() {
        let key = content_key();
        assert!(seal_chunk(key.as_slice(), &PREFIX, 0, true, &body(CHUNK_LEN + 1)).is_err());
    }

    // --- path-based sealing (the native handle-based path) ---

    /// A unique scratch directory. No `tempfile` dependency: this crate has no dev-deps and a
    /// counter plus the process id is enough for a test.
    fn scratch(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("bramble-files-{}-{tag}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn seals_and_opens_a_file_at_every_chunk_boundary() {
        let key = content_key();
        for len in [0, 1, CHUNK_LEN - 1, CHUNK_LEN, CHUNK_LEN + 1, 3 * CHUNK_LEN] {
            let dir = scratch("roundtrip");
            let src = dir.join("in.bin");
            let blob = dir.join("staging");
            let out = dir.join("out.bin");
            let plaintext = body(len);
            std::fs::write(&src, &plaintext).unwrap();

            let sealed = seal_file_at_path(key.as_slice(), &src, &blob).unwrap();

            // The streamed result must agree with the in-memory layout helpers exactly, or the
            // transfer layer's offset arithmetic is computing against a different file.
            assert_eq!(
                sealed.plaintext_size, len as u64,
                "plaintext size for {len}"
            );
            assert_eq!(sealed.size, sealed_len(len as u64), "sealed size for {len}");
            assert_eq!(
                sealed.chunk_count,
                chunk_count(len as u64),
                "chunks for {len}"
            );
            assert_eq!(
                std::fs::metadata(&blob).unwrap().len(),
                sealed.size,
                "bytes on disk for {len}"
            );
            assert_eq!(
                sealed.hash,
                blob_hash(&std::fs::read(&blob).unwrap()),
                "hash is over what was written, for {len}"
            );

            let written =
                open_file_at_path(key.as_slice(), &sealed.nonce_prefix, &blob, &out).unwrap();
            assert_eq!(written, len as u64);
            assert_eq!(
                std::fs::read(&out).unwrap(),
                plaintext,
                "round trip for {len}"
            );
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    // Streaming must produce the same ciphertext layout as the in-memory path, or a file sealed
    // on a phone could not be opened by the extension.
    #[test]
    fn a_streamed_blob_opens_with_the_in_memory_reader() {
        let key = content_key();
        let dir = scratch("cross");
        let src = dir.join("in.bin");
        let blob = dir.join("staging");
        let plaintext = body(2 * CHUNK_LEN + 99);
        std::fs::write(&src, &plaintext).unwrap();

        let sealed = seal_file_at_path(key.as_slice(), &src, &blob).unwrap();
        let opened = open_file(
            key.as_slice(),
            &sealed.nonce_prefix,
            &std::fs::read(&blob).unwrap(),
        )
        .unwrap();
        assert_eq!(opened.as_slice(), plaintext.as_slice());
        std::fs::remove_dir_all(&dir).ok();
    }

    // The point of chunking, at the UI: read page one without decrypting the whole file.
    #[test]
    fn opens_one_chunk_by_index_without_reading_the_rest() {
        let key = content_key();
        let dir = scratch("chunk");
        let src = dir.join("in.bin");
        let blob = dir.join("staging");
        let plaintext = body(3 * CHUNK_LEN + 10);
        std::fs::write(&src, &plaintext).unwrap();
        let sealed = seal_file_at_path(key.as_slice(), &src, &blob).unwrap();
        assert_eq!(sealed.chunk_count, 4);

        for index in 0..sealed.chunk_count {
            let got = open_file_chunk_at_path(key.as_slice(), &sealed.nonce_prefix, &blob, index)
                .unwrap();
            let start = index as usize * CHUNK_LEN;
            let end = plaintext.len().min(start + CHUNK_LEN);
            assert_eq!(got.as_slice(), &plaintext[start..end], "chunk {index}");
        }
        assert!(
            open_file_chunk_at_path(key.as_slice(), &sealed.nonce_prefix, &blob, 4).is_err(),
            "an index past the end is refused"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_truncated_blob_on_disk_does_not_open() {
        let key = content_key();
        let dir = scratch("truncate");
        let src = dir.join("in.bin");
        let blob = dir.join("staging");
        let out = dir.join("out.bin");
        std::fs::write(&src, body(3 * CHUNK_LEN)).unwrap();
        let sealed = seal_file_at_path(key.as_slice(), &src, &blob).unwrap();

        // Lop off the final chunk. The new last chunk was sealed as interior, so the final flag
        // rejects it rather than yielding a silently shorter file.
        let bytes = std::fs::read(&blob).unwrap();
        std::fs::write(&blob, &bytes[..2 * (CHUNK_LEN + TAG_LEN)]).unwrap();
        assert!(open_file_at_path(key.as_slice(), &sealed.nonce_prefix, &blob, &out).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_wrong_key_or_prefix_does_not_open_a_file() {
        let key = content_key();
        let dir = scratch("wrongkey");
        let src = dir.join("in.bin");
        let blob = dir.join("staging");
        let out = dir.join("out.bin");
        std::fs::write(&src, body(1000)).unwrap();
        let sealed = seal_file_at_path(key.as_slice(), &src, &blob).unwrap();

        let wrong_key = derive_file_subkeys(&[0x43; KEY_LEN]).unwrap().content;
        assert!(
            open_file_at_path(wrong_key.as_slice(), &sealed.nonce_prefix, &blob, &out).is_err()
        );
        let wrong_prefix = [0x99u8; NONCE_PREFIX_LEN];
        assert!(open_file_at_path(key.as_slice(), &wrong_prefix, &blob, &out).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn two_seals_of_the_same_file_differ() {
        // No convergent encryption: a fresh nonce prefix per seal means the same bytes get a
        // different address every time, which is what rules out confirmation-of-file.
        let key = content_key();
        let dir = scratch("distinct");
        let src = dir.join("in.bin");
        std::fs::write(&src, body(5000)).unwrap();
        let a = seal_file_at_path(key.as_slice(), &src, &dir.join("a")).unwrap();
        let b = seal_file_at_path(key.as_slice(), &src, &dir.join("b")).unwrap();
        assert_ne!(a.hash, b.hash);
        assert_ne!(a.nonce_prefix, b.nonce_prefix);
        assert_eq!(a.size, b.size);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blob_hash_matches_the_known_sha256_of_abc() {
        // NIST's canonical SHA-256("abc"), so this pins the algorithm and the hex encoding
        // rather than merely being self-consistent.
        assert_eq!(
            blob_hash(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            blob_hash(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn streaming_in_any_split_matches_one_shot() {
        let body = body(CHUNK_LEN + 1234);
        let expected = blob_hash(&body);
        for split in [1usize, 7, 4096, CHUNK_LEN, body.len()] {
            let mut hasher = BlobHasher::new();
            for part in body.chunks(split) {
                hasher.update(part);
            }
            assert_eq!(hasher.finish(), expected, "split {split}");
        }
    }

    #[test]
    fn the_hash_is_lowercase_hex_and_64_chars() {
        // FileRecord validates this shape, and it is the blob's filename on the native stores.
        let hash = blob_hash(&body(100));
        assert_eq!(hash.len(), 64);
        assert!(hash
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }

    /// Seal `plaintext` through a SealStream, the way the extension feeds it.
    fn stream_seal(plaintext: &[u8]) -> (Vec<u8>, SealedFileContent) {
        let mut stream = SealStream::new(content_key().as_slice()).unwrap();
        let count = chunk_count(plaintext.len() as u64) as usize;
        let mut blob = Vec::new();
        for i in 0..count {
            let end = plaintext.len().min((i + 1) * CHUNK_LEN);
            blob.extend(
                stream
                    .seal_next(&plaintext[i * CHUNK_LEN..end], i + 1 == count)
                    .unwrap(),
            );
        }
        (blob, stream.finish().unwrap())
    }

    fn stream_open(prefix: &[u8; NONCE_PREFIX_LEN], blob: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let mut stream = OpenStream::new(content_key().as_slice(), prefix, blob.len() as u64)?;
        // Known before a chunk is open, and exactly what the chunks add up to.
        let declared = stream.plaintext_len();
        let mut out = Vec::new();
        while let Some((offset, len)) = stream.next_range() {
            let (start, end) = (offset as usize, (offset + len) as usize);
            out.extend_from_slice(&stream.open_next(&blob[start..end])?);
        }
        assert_eq!(
            declared,
            out.len() as u64,
            "plaintext_len for {} sealed bytes",
            blob.len()
        );
        Ok(out)
    }

    #[test]
    fn a_streamed_seal_matches_the_layout_at_every_chunk_boundary() {
        for len in [0, 1, CHUNK_LEN - 1, CHUNK_LEN, CHUNK_LEN + 1, 3 * CHUNK_LEN] {
            let plaintext = body(len);
            let (blob, sealed) = stream_seal(&plaintext);
            assert_eq!(sealed.size, sealed_len(len as u64), "sealed size for {len}");
            assert_eq!(sealed.size, blob.len() as u64, "bytes out for {len}");
            assert_eq!(
                sealed.chunk_count,
                chunk_count(len as u64),
                "chunks for {len}"
            );
            assert_eq!(sealed.plaintext_size, len as u64);
            assert_eq!(
                sealed.hash,
                blob_hash(&blob),
                "hash is over what came out, for {len}"
            );
            assert_eq!(stream_open(&sealed.nonce_prefix, &blob).unwrap(), plaintext);
        }
    }

    // A file attached in the browser has to open on a phone, and the other way round.
    #[test]
    fn streamed_and_path_sealed_blobs_open_with_each_others_reader() {
        let key = content_key();
        let plaintext = body(2 * CHUNK_LEN + 99);

        let (blob, sealed) = stream_seal(&plaintext);
        let opened = open_file(key.as_slice(), &sealed.nonce_prefix, &blob).unwrap();
        assert_eq!(opened.as_slice(), plaintext.as_slice());

        let dir = scratch("stream-cross");
        let (src, staging) = (dir.join("in.bin"), dir.join("staging"));
        std::fs::write(&src, &plaintext).unwrap();
        let on_disk = seal_file_at_path(key.as_slice(), &src, &staging).unwrap();
        let bytes = std::fs::read(&staging).unwrap();
        assert_eq!(
            stream_open(&on_disk.nonce_prefix, &bytes).unwrap(),
            plaintext
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // The layout rules are what keep chunk i at a computable offset; a caller that splits a
    // file any other way must be refused, not produce a blob only it can read.
    #[test]
    fn a_seal_stream_refuses_a_misshapen_file() {
        let key = content_key();
        let mut short = SealStream::new(key.as_slice()).unwrap();
        assert!(short.seal_next(&body(100), false).is_err());

        let mut over = SealStream::new(key.as_slice()).unwrap();
        assert!(over.seal_next(&body(CHUNK_LEN + 1), true).is_err());

        let mut trailing_empty = SealStream::new(key.as_slice()).unwrap();
        trailing_empty.seal_next(&body(CHUNK_LEN), false).unwrap();
        assert!(trailing_empty.seal_next(&[], true).is_err());

        let mut after_last = SealStream::new(key.as_slice()).unwrap();
        after_last.seal_next(&body(10), true).unwrap();
        assert!(after_last.seal_next(&body(10), true).is_err());

        let mut unfinished = SealStream::new(key.as_slice()).unwrap();
        unfinished.seal_next(&body(CHUNK_LEN), false).unwrap();
        assert!(unfinished.finish().is_err());
    }

    #[test]
    fn an_open_stream_refuses_a_cut_or_misread_blob() {
        let plaintext = body(2 * CHUNK_LEN + 5);
        let (blob, sealed) = stream_seal(&plaintext);

        // Cut at a chunk boundary: the new last chunk was sealed as interior.
        let cut = &blob[..chunk_offset(2) as usize];
        assert!(stream_open(&sealed.nonce_prefix, cut).is_err());

        // Handed the wrong length for the range it asked for.
        let mut stream = OpenStream::new(
            content_key().as_slice(),
            &sealed.nonce_prefix,
            blob.len() as u64,
        )
        .unwrap();
        assert!(stream.open_next(&blob[..100]).is_err());

        // Handed chunk 1 where chunk 0 belongs.
        let mut swapped = OpenStream::new(
            content_key().as_slice(),
            &sealed.nonce_prefix,
            blob.len() as u64,
        )
        .unwrap();
        let second = &blob[chunk_offset(1) as usize..chunk_offset(2) as usize];
        assert!(swapped.open_next(second).is_err());
    }

    #[test]
    fn nonce_layout_is_prefix_index_flag() {
        let nonce = chunk_nonce(&PREFIX, 0x01020304, true);
        assert_eq!(&nonce[..NONCE_PREFIX_LEN], &PREFIX);
        assert_eq!(
            &nonce[NONCE_PREFIX_LEN..NONCE_PREFIX_LEN + 4],
            &[1, 2, 3, 4]
        );
        assert_eq!(nonce[IV_LEN - 1], 1);
        assert_eq!(chunk_nonce(&PREFIX, 0x01020304, false)[IV_LEN - 1], 0);
    }
}
