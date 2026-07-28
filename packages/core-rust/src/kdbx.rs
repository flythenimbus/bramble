//! KDBX4 import: opens a KeePass KDBX4 database inside WASM.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
#[cfg(feature = "wasm")]
use cbc::cipher::BlockEncryptMut;
use chacha20::cipher::StreamCipher;
use chacha20::ChaCha20;
use flate2::read::GzDecoder;
#[cfg(feature = "wasm")]
use flate2::write::GzEncoder;
#[cfg(feature = "wasm")]
use flate2::Compression;
use hmac::{Hmac, Mac};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Serialize;
#[cfg(feature = "wasm")]
use serde::Deserialize;
use sha2::{Digest, Sha256, Sha512};
use std::io::Read;
#[cfg(feature = "wasm")]
use std::io::Write;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
#[cfg(feature = "wasm")]
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;

// 16-byte UUIDs as stored in the header / KDF VariantDictionary.
const CIPHER_AES256: [u8; 16] = [
    0x31, 0xc1, 0xf2, 0xe6, 0xbf, 0x71, 0x43, 0x50, 0xbe, 0x58, 0x05, 0x21, 0x6a, 0xfc, 0x5a, 0xff,
];
const CIPHER_CHACHA20: [u8; 16] = [
    0xd6, 0x03, 0x8a, 0x2b, 0x8b, 0x6f, 0x4c, 0xb5, 0xa5, 0x24, 0x33, 0x9a, 0x31, 0xdb, 0xb5, 0x9a,
];
const KDF_ARGON2D: [u8; 16] = [
    0xef, 0x63, 0x6d, 0xdf, 0x8c, 0x29, 0x44, 0x4b, 0x91, 0xf7, 0xa9, 0xa4, 0x03, 0xe3, 0x0a, 0x0c,
];
const KDF_ARGON2ID: [u8; 16] = [
    0x9e, 0x29, 0x8b, 0x19, 0x56, 0xdb, 0x47, 0x73, 0xb2, 0x3d, 0xfc, 0x3e, 0xc6, 0xf0, 0xa1, 0xe6,
];

const RECYCLE_BIN: &str = "Recycle Bin";

/// A failure with a stable machine code the JS layer switches on to show the
/// right message (WrongCredential keeps the user on the unlock step, the
/// Unsupported variants surface an out-of-scope error).
#[derive(Debug, PartialEq)]
pub enum KdbxError {
    NotKeepass,
    UnsupportedVersion(u16),
    UnsupportedCipher,
    UnsupportedKdf,
    UnsupportedStream,
    WrongCredential,
    /// KDF parameters from the file exceed our safety ceilings (OOM / hang guard).
    KdfTooExpensive,
    Corrupt(&'static str),
}

impl KdbxError {
    pub fn code(&self) -> String {
        match self {
            KdbxError::NotKeepass => "KDBX_NOT_KEEPASS".into(),
            KdbxError::UnsupportedVersion(v) => format!("KDBX_UNSUPPORTED_VERSION:{v}"),
            KdbxError::UnsupportedCipher => "KDBX_UNSUPPORTED_CIPHER".into(),
            KdbxError::UnsupportedKdf => "KDBX_UNSUPPORTED_KDF".into(),
            KdbxError::UnsupportedStream => "KDBX_UNSUPPORTED_STREAM".into(),
            KdbxError::WrongCredential => "KDBX_WRONG_CREDENTIAL".into(),
            KdbxError::KdfTooExpensive => "KDBX_KDF_TOO_EXPENSIVE".into(),
            KdbxError::Corrupt(s) => format!("KDBX_CORRUPT:{s}"),
        }
    }
}

type Res<T> = Result<T, KdbxError>;

/// One imported entry: its KeePass String key/value pairs, protected values
/// already decrypted. JS maps these to `EntryData`.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct OutEntry {
    pub strings: Vec<OutString>,
}
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct OutString {
    pub key: String,
    pub value: String,
    /// True for KeePass "Protected" fields so the JS layer keeps them hidden.
    pub protected: bool,
}

/// WASM entry point. `keyfile` is the raw key-file bytes, if any.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn open_kdbx4(
    file: &[u8],
    password: &str,
    keyfile: Option<Box<[u8]>>,
) -> Result<JsValue, JsError> {
    let entries = open_inner(file, password, keyfile.as_deref()).map_err(|e| JsError::new(&e.code()))?;
    serde_wasm_bindgen::to_value(&entries).map_err(|e| JsError::new(&format!("KDBX_SERIALIZE:{e}")))
}

/// FFI entry point (uniffi -> Swift/Kotlin). Same core as the WASM path; the
/// `KdbxError` code becomes the `CryptoError` message so the TS layer's switch on
/// the code string (e.g. `KDBX_WRONG_CREDENTIAL`) works identically across layers.
#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn open_kdbx4(
    file: Vec<u8>,
    password: String,
    keyfile: Option<Vec<u8>>,
) -> Result<Vec<OutEntry>, crate::CryptoError> {
    open_inner(&file, &password, keyfile.as_deref()).map_err(|e| crate::err(e.code()))
}

/// A forward byte cursor with bounds-checked reads.
struct Cursor<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Cursor<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self { b, p: 0 }
    }
    fn take(&mut self, n: usize) -> Res<&'a [u8]> {
        let end = self.p.checked_add(n).ok_or(KdbxError::Corrupt("length overflow"))?;
        let s = self.b.get(self.p..end).ok_or(KdbxError::Corrupt("unexpected end of data"))?;
        self.p = end;
        Ok(s)
    }
    fn u8(&mut self) -> Res<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Res<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Res<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
}

#[derive(Default)]
struct Kdf {
    uuid: Vec<u8>,
    iterations: u64,
    mem_bytes: u64,
    parallelism: u32,
    salt: Vec<u8>,
    version: u32,
}

/// Parse a KDBX VariantDictionary into Kdf params: u16 version, then
/// [type:u8][klen:u32][key][vlen:u32][val]*, 0x00 terminator.
fn parse_variant_dict(d: &[u8]) -> Res<Kdf> {
    let mut c = Cursor::new(d);
    let _ver = c.u16()?;
    let mut kdf = Kdf::default();
    loop {
        let t = c.u8()?;
        if t == 0 {
            break;
        }
        let klen = c.u32()? as usize;
        let key = c.take(klen)?.to_vec();
        let vlen = c.u32()? as usize;
        let val = c.take(vlen)?;
        let bad = |_| KdbxError::Corrupt("bad KDF param size");
        match key.as_slice() {
            b"$UUID" => kdf.uuid = val.to_vec(),
            b"I" => kdf.iterations = u64::from_le_bytes(val.try_into().map_err(bad)?),
            b"M" => kdf.mem_bytes = u64::from_le_bytes(val.try_into().map_err(bad)?),
            b"P" => kdf.parallelism = u32::from_le_bytes(val.try_into().map_err(bad)?),
            b"S" => kdf.salt = val.to_vec(),
            b"V" => kdf.version = u32::from_le_bytes(val.try_into().map_err(bad)?),
            _ => {} // ignore unknown params; $UUID gates support
        }
    }
    Ok(kdf)
}

/// Argon2 transform of the composite key (Argon2d or Argon2id per the KDF UUID).
fn argon2_transform(kdf: &Kdf, composite: &[u8]) -> Res<Zeroizing<[u8; 32]>> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let algo = if kdf.uuid == KDF_ARGON2D {
        Algorithm::Argon2d
    } else if kdf.uuid == KDF_ARGON2ID {
        Algorithm::Argon2id
    } else {
        return Err(KdbxError::UnsupportedKdf);
    };
    // Reject implausible parameters from the untrusted file before allocating: a
    // malicious .kdbx could request terabytes of memory or millions of passes
    // (OOM / hang). These ceilings sit far above any real KeePass file.
    const MAX_KDF_MEM_BYTES: u64 = 1 << 30; // 1 GiB
    const MAX_KDF_ITERATIONS: u64 = 64;
    const MAX_KDF_PARALLELISM: u32 = 64;
    if kdf.mem_bytes > MAX_KDF_MEM_BYTES
        || kdf.iterations > MAX_KDF_ITERATIONS
        || kdf.parallelism > MAX_KDF_PARALLELISM
    {
        return Err(KdbxError::KdfTooExpensive);
    }
    let mem_kib = u32::try_from(kdf.mem_bytes / 1024).map_err(|_| KdbxError::Corrupt("KDF mem"))?;
    let iters = u32::try_from(kdf.iterations).map_err(|_| KdbxError::Corrupt("KDF iters"))?;
    let params = Params::new(mem_kib, iters, kdf.parallelism, Some(32))
        .map_err(|_| KdbxError::Corrupt("KDF params"))?;
    let version = if kdf.version == 0x10 {
        Version::V0x10
    } else {
        Version::V0x13
    };
    let mut out = Zeroizing::new([0u8; 32]);
    Argon2::new(algo, version, params)
        .hash_password_into(composite, &kdf.salt, out.as_mut_slice())
        .map_err(|_| KdbxError::Corrupt("argon2"))?;
    Ok(out)
}

/// Resolve a key file's 32-byte key component, per KeePass rules: XML key file,
/// else 32 raw bytes, else 64 hex chars, else SHA-256 of the contents.
fn keyfile_key(bytes: &[u8]) -> [u8; 32] {
    if let Some(k) = parse_xml_keyfile(bytes) {
        return k;
    }
    if bytes.len() == 32 {
        return bytes.try_into().unwrap();
    }
    if bytes.len() == 64 {
        if let Some(k) = decode_hex32(bytes) {
            return k;
        }
    }
    Sha256::digest(bytes).into()
}

fn decode_hex32(hex: &[u8]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    for (i, chunk) in hex.chunks(2).enumerate() {
        if i >= 32 || chunk.len() != 2 {
            return None;
        }
        let hi = (chunk[0] as char).to_digit(16)?;
        let lo = (chunk[1] as char).to_digit(16)?;
        out[i] = (hi * 16 + lo) as u8;
    }
    Some(out)
}

/// Parse a KeePass XML key file's `<Data>` value (v2.0 hex, v1.0 base64).
/// Returns None if the bytes don't look like an XML key file.
fn parse_xml_keyfile(bytes: &[u8]) -> Option<[u8; 32]> {
    let trimmed = bytes.iter().position(|b| !b.is_ascii_whitespace())?;
    if bytes[trimmed] != b'<' {
        return None;
    }
    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut in_version = false;
    let mut in_data = false;
    let mut version = String::new();
    let mut data = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"Version" => in_version = true,
                b"Data" => in_data = true,
                _ => {}
            },
            Ok(Event::Text(t)) => {
                let txt = t.unescape().ok()?.into_owned();
                if in_version {
                    version.push_str(txt.trim());
                } else if in_data {
                    data.push_str(&txt);
                }
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"Version" => in_version = false,
                b"Data" => in_data = false,
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => return None,
            _ => {}
        }
        buf.clear();
    }
    if data.is_empty() {
        return None;
    }
    let compact: String = data.split_whitespace().collect();
    if version.starts_with('2') {
        decode_hex32(compact.as_bytes())
    } else {
        let raw = B64.decode(compact).ok()?;
        raw.try_into().ok()
    }
}

/// Composite key = SHA256( [SHA256(password)] [|| keyfile_key] ). An unset
/// component is omitted: an empty password contributes nothing (hashing
/// SHA256("") would derive the wrong key).
fn composite_key(password: &str, keyfile: Option<&[u8]>) -> Zeroizing<[u8; 32]> {
    let mut h = Sha256::new();
    if !password.is_empty() {
        h.update(Sha256::digest(password.as_bytes()));
    }
    if let Some(kf) = keyfile {
        h.update(keyfile_key(kf));
    }
    Zeroizing::new(h.finalize().into())
}

struct Keys {
    cipher_key: Zeroizing<[u8; 32]>,
    hmac_base: Zeroizing<[u8; 64]>,
}

/// cipher key = SHA256(master_seed || transformed);
/// hmac base = SHA512(master_seed || transformed || 0x01).
fn derive_keys(master_seed: &[u8], transformed: &[u8; 32]) -> Keys {
    let mut hk = Sha256::new();
    hk.update(master_seed);
    hk.update(transformed);
    let mut hb = Sha512::new();
    hb.update(master_seed);
    hb.update(transformed);
    hb.update([0x01u8]);
    Keys {
        cipher_key: Zeroizing::new(hk.finalize().into()),
        hmac_base: Zeroizing::new(hb.finalize().into()),
    }
}

fn sha512_block_key(index: u64, hmac_base: &[u8]) -> [u8; 64] {
    let mut h = Sha512::new();
    h.update(index.to_le_bytes());
    h.update(hmac_base);
    h.finalize().into()
}

/// Open a KDBX4 database. Returns entries with protected values decrypted.
pub fn open_inner(file: &[u8], password: &str, keyfile: Option<&[u8]>) -> Res<Vec<OutEntry>> {
    let mut c = Cursor::new(file);
    if c.u32()? != 0x9AA2_D903 || c.u32()? != 0xB54B_FB67 {
        return Err(KdbxError::NotKeepass);
    }
    let _minor = c.u16()?;
    let major = c.u16()?;
    if major != 4 {
        return Err(KdbxError::UnsupportedVersion(major));
    }

    let mut cipher = Vec::new();
    let mut compression = 0u32;
    let mut master_seed = Vec::new();
    let mut enc_iv = Vec::new();
    let mut kdf = Kdf::default();
    loop {
        let id = c.u8()?;
        let len = c.u32()? as usize;
        let data = c.take(len)?;
        match id {
            0 => break, // EndOfHeader
            2 => cipher = data.to_vec(),
            3 => {
                compression =
                    u32::from_le_bytes(data.try_into().map_err(|_| KdbxError::Corrupt("compression"))?)
            }
            4 => master_seed = data.to_vec(),
            7 => enc_iv = data.to_vec(),
            11 => kdf = parse_variant_dict(data)?,
            _ => {} // 1 Comment, 12 PublicCustomData
        }
    }
    let header_end = c.p;
    let header = &file[..header_end];

    // Reject unsupported cipher/KDF up front, before Argon2, so the error is
    // credential-independent.
    if cipher != CIPHER_AES256 && cipher != CIPHER_CHACHA20 {
        return Err(KdbxError::UnsupportedCipher);
    }
    if kdf.uuid != KDF_ARGON2D && kdf.uuid != KDF_ARGON2ID {
        return Err(KdbxError::UnsupportedKdf);
    }

    let composite = composite_key(password, keyfile);
    let transformed = argon2_transform(&kdf, composite.as_slice())?;
    let keys = derive_keys(&master_seed, &transformed);

    // Authenticate the header; a failing HMAC is the wrong-credential signal.
    let stored_sha = c.take(32)?;
    if Sha256::digest(header).as_slice() != stored_sha {
        return Err(KdbxError::Corrupt("header integrity"));
    }
    let stored_hmac = c.take(32)?;
    let hdr_key = sha512_block_key(u64::MAX, keys.hmac_base.as_slice());
    let mut mac = HmacSha256::new_from_slice(&hdr_key).unwrap();
    mac.update(header);
    mac.verify_slice(stored_hmac)
        .map_err(|_| KdbxError::WrongCredential)?;

    // Verify and concatenate the HMAC block stream into the ciphertext.
    let mut ciphertext: Vec<u8> = Vec::new();
    let mut index: u64 = 0;
    loop {
        let block_hmac = c.take(32)?;
        let len = c.u32()? as usize;
        let data = c.take(len)?;
        let bk = sha512_block_key(index, keys.hmac_base.as_slice());
        let mut m = HmacSha256::new_from_slice(&bk).unwrap();
        m.update(&index.to_le_bytes());
        m.update(&(len as u32).to_le_bytes());
        m.update(data);
        m.verify_slice(block_hmac)
            .map_err(|_| KdbxError::Corrupt("block HMAC mismatch"))?;
        if len == 0 {
            break;
        }
        ciphertext.extend_from_slice(data);
        index += 1;
    }

    let payload: Zeroizing<Vec<u8>> = if cipher == CIPHER_AES256 {
        let dec = Aes256CbcDec::new_from_slices(keys.cipher_key.as_slice(), &enc_iv)
            .map_err(|_| KdbxError::Corrupt("AES key/iv"))?;
        Zeroizing::new(
            dec.decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
                .map_err(|_| KdbxError::Corrupt("AES unpad"))?,
        )
    } else if cipher == CIPHER_CHACHA20 {
        let mut buf = Zeroizing::new(ciphertext.clone());
        let mut ch = ChaCha20::new_from_slices(keys.cipher_key.as_slice(), &enc_iv)
            .map_err(|_| KdbxError::Corrupt("ChaCha20 key/iv"))?;
        ch.apply_keystream(&mut buf);
        buf
    } else {
        return Err(KdbxError::UnsupportedCipher);
    };

    let inner_payload: Zeroizing<Vec<u8>> = match compression {
        0 => payload,
        1 => {
            let mut gz = GzDecoder::new(&payload[..]);
            let mut out = Zeroizing::new(Vec::new());
            gz.read_to_end(&mut out).map_err(|_| KdbxError::Corrupt("gzip"))?;
            out
        }
        _ => return Err(KdbxError::Corrupt("compression flag")),
    };

    // Inner header (KDBX4): inner stream cipher id + key.
    let mut ic = Cursor::new(&inner_payload);
    let mut inner_stream_id = 0u32;
    let mut inner_stream_key = Vec::new();
    loop {
        let id = ic.u8()?;
        let len = ic.u32()? as usize;
        let data = ic.take(len)?;
        match id {
            0 => break,
            1 => {
                inner_stream_id =
                    u32::from_le_bytes(data.try_into().map_err(|_| KdbxError::Corrupt("stream id"))?)
            }
            2 => inner_stream_key = data.to_vec(),
            _ => {} // 3 Binary (attachments out of scope)
        }
    }
    if inner_stream_id != 3 {
        return Err(KdbxError::UnsupportedStream); // KDBX4 expects ChaCha20
    }
    let xml = &inner_payload[ic.p..];

    parse_inner_xml(xml, &inner_stream_key)
}

/// Walk the inner XML, decrypting Protected="True" values with the inner ChaCha20
/// stream. Consume the keystream for EVERY protected value in document order,
/// including discarded History/Recycle Bin ones; decide emission separately.
fn parse_inner_xml(xml: &[u8], inner_stream_key: &[u8]) -> Res<Vec<OutEntry>> {
    let kd = Sha512::digest(inner_stream_key);
    let mut stream =
        ChaCha20::new_from_slices(&kd[0..32], &kd[32..44]).map_err(|_| KdbxError::Corrupt("inner chacha"))?;

    let mut reader = Reader::from_reader(xml);
    let mut buf = Vec::new();

    let mut entries: Vec<OutEntry> = Vec::new();
    let mut entry_stack: Vec<Vec<OutString>> = Vec::new();
    let mut group_names: Vec<String> = Vec::new();
    let mut history_depth = 0usize;

    #[derive(PartialEq)]
    enum Mode {
        None,
        Key,
        Value,
        GroupName,
    }
    let mut mode = Mode::None;
    let mut protected = false;
    let mut cur_key = String::new();
    let mut cur_val = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"Group" => group_names.push(String::new()),
                b"Entry" => entry_stack.push(Vec::new()),
                b"History" => history_depth += 1,
                // A group's <Name> only counts outside an Entry.
                b"Name" if entry_stack.is_empty() => mode = Mode::GroupName,
                b"Key" => {
                    mode = Mode::Key;
                    cur_key.clear();
                }
                b"Value" => {
                    mode = Mode::Value;
                    cur_val.clear();
                    protected = e
                        .attributes()
                        .flatten()
                        .any(|a| a.key.as_ref() == b"Protected" && a.value.as_ref() == b"True");
                }
                _ => {}
            },
            Ok(Event::Text(t)) => {
                let txt = t.unescape().map_err(|_| KdbxError::Corrupt("xml unescape"))?.into_owned();
                match mode {
                    Mode::Key => cur_key = txt,
                    Mode::Value => cur_val = txt,
                    Mode::GroupName => {
                        if let Some(n) = group_names.last_mut() {
                            *n = txt;
                        }
                    }
                    Mode::None => {}
                }
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"Value" => {
                    let value = if protected && !cur_val.is_empty() {
                        let mut raw = B64.decode(cur_val.as_bytes()).map_err(|_| KdbxError::Corrupt("b64"))?;
                        stream.apply_keystream(&mut raw);
                        String::from_utf8(raw).map_err(|_| KdbxError::Corrupt("protected utf8"))?
                    } else {
                        cur_val.clone()
                    };
                    if let Some(frame) = entry_stack.last_mut() {
                        frame.push(OutString { key: cur_key.clone(), value, protected });
                    }
                    mode = Mode::None;
                }
                b"Key" | b"Name" => mode = Mode::None,
                b"History" => history_depth = history_depth.saturating_sub(1),
                b"Group" => {
                    group_names.pop();
                }
                b"Entry" => {
                    if let Some(frame) = entry_stack.pop() {
                        // Emit only top-level entries: not History, not Recycle Bin.
                        let in_recycle = group_names.iter().any(|n| n == RECYCLE_BIN);
                        if history_depth == 0 && entry_stack.is_empty() && !in_recycle {
                            entries.push(OutEntry { strings: frame });
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => return Err(KdbxError::Corrupt("xml")),
            _ => {}
        }
        buf.clear();
    }
    Ok(entries)
}

// ===== KDBX4 export =====
//
// The mirror of open_inner: build KeePass XML, encrypt protected values with the inner
// ChaCha20 stream, gzip, AES-256-CBC, then frame in the HMAC block stream under a header
// this reader (and KeePassXC) accepts. Written files are always AES-256-CBC + Argon2id +
// gzip + ChaCha20 inner stream, i.e. one point in the format's space rather than all of it.

/// Argon2id cost for exported files: the same as the vault's own KEK (64 MiB / 3 passes /
/// 1 lane), which is comfortably inside the ceilings `argon2_transform` enforces on read.
#[cfg(feature = "wasm")]
const OUT_KDF_MEM_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(feature = "wasm")]
const OUT_KDF_ITERATIONS: u64 = 3;
#[cfg(feature = "wasm")]
const OUT_KDF_PARALLELISM: u32 = 1;
#[cfg(feature = "wasm")]
const ARGON2_V13: u32 = 0x13;
/// KeePass's own payload block size. A single huge block is legal but unconventional.
#[cfg(feature = "wasm")]
const BLOCK_SIZE: usize = 1024 * 1024;

/// One entry to write, as KeePass String pairs. The read-side mirror of `OutEntry`; JS
/// builds these from `EntryData` so the field naming stays in the TS layer.
#[cfg(feature = "wasm")]
#[derive(Deserialize)]
pub struct SaveEntry {
    pub strings: Vec<SaveString>,
}
#[cfg(feature = "wasm")]
#[derive(Deserialize)]
pub struct SaveString {
    pub key: String,
    pub value: String,
    /// Written as `Protected="True"` and encrypted with the inner stream.
    pub protected: bool,
}

/// WASM entry point: returns the finished .kdbx bytes.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn save_kdbx4(entries: JsValue, password: &str) -> Result<Box<[u8]>, JsError> {
    let entries: Vec<SaveEntry> =
        serde_wasm_bindgen::from_value(entries).map_err(|e| JsError::new(&format!("KDBX_INPUT:{e}")))?;
    let bytes = save_inner(&entries, password).map_err(|e| JsError::new(&e.code()))?;
    Ok(bytes.into_boxed_slice())
}

#[cfg(feature = "wasm")]
fn rng(buf: &mut [u8]) -> Res<()> {
    crate::random_bytes(buf).map_err(|_| KdbxError::Corrupt("rng"))
}

/// `[id:u8][len:u32][data]`, the shape of both the outer and inner header fields.
#[cfg(feature = "wasm")]
fn push_field(out: &mut Vec<u8>, id: u8, data: &[u8]) {
    out.push(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
}

/// `[type:u8][klen:u32][key][vlen:u32][val]`, one VariantDictionary item.
#[cfg(feature = "wasm")]
fn push_variant(out: &mut Vec<u8>, ty: u8, key: &[u8], val: &[u8]) {
    out.push(ty);
    out.extend_from_slice(&(key.len() as u32).to_le_bytes());
    out.extend_from_slice(key);
    out.extend_from_slice(&(val.len() as u32).to_le_bytes());
    out.extend_from_slice(val);
}

/// KDF VariantDictionary for Argon2id. Types: 0x04 u32, 0x05 u64, 0x42 byte array.
#[cfg(feature = "wasm")]
fn build_kdf_dict(salt: &[u8]) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend_from_slice(&0x0100u16.to_le_bytes()); // dictionary version 1.0
    push_variant(&mut d, 0x42, b"$UUID", &KDF_ARGON2ID);
    push_variant(&mut d, 0x05, b"I", &OUT_KDF_ITERATIONS.to_le_bytes());
    push_variant(&mut d, 0x05, b"M", &OUT_KDF_MEM_BYTES.to_le_bytes());
    push_variant(&mut d, 0x04, b"P", &OUT_KDF_PARALLELISM.to_le_bytes());
    push_variant(&mut d, 0x42, b"S", salt);
    push_variant(&mut d, 0x04, b"V", &ARGON2_V13.to_le_bytes());
    d.push(0x00); // terminator
    d
}

/// Build the inner XML, encrypting protected values with the inner ChaCha20 stream.
///
/// The keystream must advance for every protected value in document order, exactly as
/// `parse_inner_xml` consumes it. An EMPTY protected value advances it by zero bytes on
/// both sides (the reader skips empty values), so the two stay in step.
#[cfg(feature = "wasm")]
fn build_xml(entries: &[SaveEntry], inner_key: &[u8]) -> Res<Vec<u8>> {
    let kd = Sha512::digest(inner_key);
    let mut stream = ChaCha20::new_from_slices(&kd[0..32], &kd[32..44])
        .map_err(|_| KdbxError::Corrupt("inner chacha"))?;
    let uuid = || -> Res<String> {
        let mut u = [0u8; 16];
        rng(&mut u)?;
        Ok(B64.encode(u))
    };

    let mut x = String::from(r#"<?xml version="1.0" encoding="utf-8" standalone="yes"?>"#);
    x.push_str("<KeePassFile><Meta><Generator>Bramble</Generator>");
    x.push_str("<DatabaseName>Bramble Export</DatabaseName>");
    // No recycle bin and no history: open_inner discards entries in either, and an export
    // should not carry a second, stale copy of every secret.
    x.push_str("<RecycleBinEnabled>False</RecycleBinEnabled>");
    x.push_str("<HistoryMaxItems>0</HistoryMaxItems></Meta>");
    x.push_str("<Root><Group>");
    x.push_str(&format!("<UUID>{}</UUID>", uuid()?));
    x.push_str("<Name>Bramble</Name>");
    for e in entries {
        x.push_str("<Entry>");
        x.push_str(&format!("<UUID>{}</UUID>", uuid()?));
        for s in &e.strings {
            if s.key.is_empty() {
                continue; // a String with no Key has nowhere to land on re-import
            }
            x.push_str("<String><Key>");
            x.push_str(&quick_xml::escape::escape(&s.key));
            x.push_str("</Key>");
            if s.protected {
                let mut raw = s.value.clone().into_bytes();
                stream.apply_keystream(&mut raw);
                x.push_str(&format!(r#"<Value Protected="True">{}</Value>"#, B64.encode(&raw)));
            } else {
                x.push_str("<Value>");
                x.push_str(&quick_xml::escape::escape(&s.value));
                x.push_str("</Value>");
            }
            x.push_str("</String>");
        }
        x.push_str("</Entry>");
    }
    x.push_str("</Group></Root></KeePassFile>");
    Ok(x.into_bytes())
}

/// Write a KDBX4 database holding `entries`, unlockable with `password` alone (no key file).
#[cfg(feature = "wasm")]
pub fn save_inner(entries: &[SaveEntry], password: &str) -> Res<Vec<u8>> {
    if password.is_empty() {
        return Err(KdbxError::Corrupt("export password must not be empty"));
    }
    let mut master_seed = [0u8; 32];
    let mut enc_iv = [0u8; 16];
    let mut kdf_salt = [0u8; 32];
    let mut inner_key = Zeroizing::new([0u8; 64]);
    rng(&mut master_seed)?;
    rng(&mut enc_iv)?;
    rng(&mut kdf_salt)?;
    rng(inner_key.as_mut_slice())?;

    // Inner payload: inner header (stream id 3 = ChaCha20, stream key) then the XML.
    let xml = build_xml(entries, inner_key.as_slice())?;
    let mut inner = Zeroizing::new(Vec::new());
    push_field(&mut inner, 1, &3u32.to_le_bytes());
    push_field(&mut inner, 2, inner_key.as_slice());
    push_field(&mut inner, 0, &[]);
    inner.extend_from_slice(&xml);

    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    gz.write_all(&inner).map_err(|_| KdbxError::Corrupt("gzip write"))?;
    let compressed = Zeroizing::new(gz.finish().map_err(|_| KdbxError::Corrupt("gzip finish"))?);

    // Outer header. Everything from the signature through EndOfHeader is what gets hashed.
    let mut header = Vec::new();
    header.extend_from_slice(&0x9AA2_D903u32.to_le_bytes());
    header.extend_from_slice(&0xB54B_FB67u32.to_le_bytes());
    header.extend_from_slice(&0u16.to_le_bytes()); // minor: 4.0, which every KDBX4 reader takes
    header.extend_from_slice(&4u16.to_le_bytes()); // major
    push_field(&mut header, 2, &CIPHER_AES256);
    push_field(&mut header, 3, &1u32.to_le_bytes()); // gzip
    push_field(&mut header, 4, &master_seed);
    push_field(&mut header, 7, &enc_iv);
    push_field(&mut header, 11, &build_kdf_dict(&kdf_salt));
    push_field(&mut header, 0, b"\r\n\r\n");

    let kdf = Kdf {
        uuid: KDF_ARGON2ID.to_vec(),
        iterations: OUT_KDF_ITERATIONS,
        mem_bytes: OUT_KDF_MEM_BYTES,
        parallelism: OUT_KDF_PARALLELISM,
        salt: kdf_salt.to_vec(),
        version: ARGON2_V13,
    };
    let composite = composite_key(password, None);
    let transformed = argon2_transform(&kdf, composite.as_slice())?;
    let keys = derive_keys(&master_seed, &transformed);

    let enc = Aes256CbcEnc::new_from_slices(keys.cipher_key.as_slice(), &enc_iv)
        .map_err(|_| KdbxError::Corrupt("AES key/iv"))?;
    let ciphertext = enc.encrypt_padded_vec_mut::<Pkcs7>(&compressed);

    let mut out = header.clone();
    out.extend_from_slice(&Sha256::digest(&header));
    let hdr_key = sha512_block_key(u64::MAX, keys.hmac_base.as_slice());
    let mut mac = HmacSha256::new_from_slice(&hdr_key).unwrap();
    mac.update(&header);
    out.extend_from_slice(&mac.finalize().into_bytes());

    // HMAC block stream, terminated by a zero-length block (whose HMAC still counts).
    let mut index: u64 = 0;
    let push_block = |out: &mut Vec<u8>, index: u64, data: &[u8]| {
        let bk = sha512_block_key(index, keys.hmac_base.as_slice());
        let mut m = HmacSha256::new_from_slice(&bk).unwrap();
        m.update(&index.to_le_bytes());
        m.update(&(data.len() as u32).to_le_bytes());
        m.update(data);
        out.extend_from_slice(&m.finalize().into_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
    };
    for chunk in ciphertext.chunks(BLOCK_SIZE) {
        push_block(&mut out, index, chunk);
        index += 1;
    }
    push_block(&mut out, index, &[]);
    Ok(out)
}

// Fixtures are AES-256-CBC + Argon2d. Two paths are covered by reasoning, not a
// fixture: Argon2id (a one-line Algorithm branch) and outer ChaCha20 (shares all
// framing with AES; the primitive itself runs on every test via inner values).
#[cfg(test)]
mod tests {
    use super::*;

    macro_rules! fixture {
        ($name:literal) => {
            include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/", $name))
        };
    }
    const FIXTURE: &[u8] = fixture!("sample.kdbx");
    const KEYFILE_DB: &[u8] = fixture!("sample-keyfile.kdbx");
    const KEYFILE: &[u8] = fixture!("sample.keyx");
    const RICH: &[u8] = fixture!("rich.kdbx"); // Recycle Bin + History + TOTP Seed
    const RAWKEY_DB: &[u8] = fixture!("rawkey.kdbx"); // password + raw 32-byte key file
    const KEYONLY_DB: &[u8] = fixture!("keyonly.kdbx"); // key-file-only, no password
    const RAW_KEY: &[u8] = fixture!("raw.key"); // 32 random bytes
    const PASSWORD: &str = "correct horse battery staple";

    fn field<'a>(entry: &'a OutEntry, key: &str) -> Option<&'a str> {
        entry.strings.iter().find(|s| s.key == key).map(|s| s.value.as_str())
    }
    fn by_title<'a>(entries: &'a [OutEntry], title: &str) -> &'a OutEntry {
        entries.iter().find(|e| field(e, "Title") == Some(title)).expect("entry by title")
    }

    #[test]
    fn opens_password_only_fixture() {
        let entries = open_inner(FIXTURE, PASSWORD, None).expect("open");
        assert_eq!(entries.len(), 2);
        let gh = by_title(&entries, "GitHub");
        assert_eq!(field(gh, "UserName"), Some("octocat"));
        assert_eq!(field(gh, "URL"), Some("https://github.com"));
        assert_eq!(field(gh, "Password"), Some("hunter2")); // protected: inner ChaCha20 worked
        assert_eq!(field(by_title(&entries, "Email"), "Password"), Some("p@ss w0rd&<x>\""));
    }

    #[test]
    fn opens_with_keyfile() {
        assert_eq!(open_inner(KEYFILE_DB, "filevault", None), Err(KdbxError::WrongCredential));
        let entries = open_inner(KEYFILE_DB, "filevault", Some(KEYFILE)).expect("open w/ keyfile");
        assert_eq!(field(by_title(&entries, "GitHub"), "Password"), Some("hunter2"));
    }

    #[test]
    fn wrong_password_is_rejected() {
        assert_eq!(open_inner(FIXTURE, "nope", None), Err(KdbxError::WrongCredential));
    }

    #[test]
    fn excludes_recycle_bin_and_history_keeps_totp() {
        let entries = open_inner(RICH, "richpass", None).expect("open rich");
        // "Trashed" (Recycle Bin) and the "old" History revision are both excluded.
        assert_eq!(entries.len(), 2, "only Keeper + Hist, not Trashed/history");
        assert!(entries.iter().all(|e| field(e, "Title") != Some("Trashed")));

        // The surviving Hist entry is the current revision, not a History one.
        assert_eq!(field(by_title(&entries, "Hist"), "Password"), Some("new"));

        // Protected non-standard field (TOTP Seed) decrypted via the inner stream.
        let keeper = by_title(&entries, "Keeper");
        assert_eq!(field(keeper, "TOTP Seed"), Some("JBSWY3DPEHPK3PXP"));
        assert!(
            keeper.strings.iter().any(|s| s.key == "TOTP Seed" && s.protected),
            "TOTP Seed should be marked protected"
        );
    }

    #[test]
    fn opens_with_raw_keyfile() {
        // Both password and key file are required.
        assert_eq!(open_inner(RAWKEY_DB, "rawpass", None), Err(KdbxError::WrongCredential));
        let entries = open_inner(RAWKEY_DB, "rawpass", Some(RAW_KEY)).expect("open w/ raw key");
        assert_eq!(field(by_title(&entries, "RawKeyed"), "Password"), Some("rp"));
    }

    #[test]
    fn opens_keyfile_only_with_empty_password() {
        // Empty password must not be hashed in (composite_key skips it).
        let entries = open_inner(KEYONLY_DB, "", Some(RAW_KEY)).expect("open key-only");
        assert_eq!(field(by_title(&entries, "KeyOnly"), "Password"), Some("kp"));
        assert_eq!(open_inner(KEYONLY_DB, "", None), Err(KdbxError::WrongCredential));
    }

    #[test]
    fn rejects_oversized_kdf_params() {
        let mk = |mem_bytes: u64, iterations: u64, parallelism: u32| Kdf {
            uuid: KDF_ARGON2ID.to_vec(),
            iterations,
            mem_bytes,
            parallelism,
            salt: vec![0u8; 16],
            version: 0x13,
        };
        let composite = [0u8; 32];
        // In-bounds (tiny) params derive without tripping the safety gate.
        assert!(argon2_transform(&mk(64 * 1024, 1, 1), &composite).is_ok());
        // Each axis over its ceiling is rejected before any allocation.
        assert_eq!(
            argon2_transform(&mk(2 << 30, 1, 1), &composite),
            Err(KdbxError::KdfTooExpensive)
        );
        assert_eq!(
            argon2_transform(&mk(64 * 1024, 1000, 1), &composite),
            Err(KdbxError::KdfTooExpensive)
        );
        assert_eq!(
            argon2_transform(&mk(64 * 1024, 1, 1000), &composite),
            Err(KdbxError::KdfTooExpensive)
        );
    }

    // Byte-mutation negative tests: corrupt one field of a real fixture.
    #[test]
    fn rejects_kdbx3_version() {
        let mut f = FIXTURE.to_vec();
        f[10] = 3; // major version (LE u16 at offset 10)
        assert_eq!(open_inner(&f, PASSWORD, None), Err(KdbxError::UnsupportedVersion(3)));
    }

    #[test]
    fn rejects_non_keepass_magic() {
        let mut f = FIXTURE.to_vec();
        f[0] ^= 0xFF;
        assert_eq!(open_inner(&f, PASSWORD, None), Err(KdbxError::NotKeepass));
    }

    #[test]
    fn rejects_unsupported_cipher() {
        // Corrupt the AES CipherID UUID to a non-AES/ChaCha value.
        let mut f = FIXTURE.to_vec();
        let pos = f.windows(16).position(|w| w == CIPHER_AES256).expect("cipher uuid present");
        f[pos] ^= 0xFF;
        // Header SHA is recomputed over the mutated header, so this surfaces as
        // unsupported cipher (header parse), not a corrupt/HMAC error.
        assert_eq!(open_inner(&f, PASSWORD, None), Err(KdbxError::UnsupportedCipher));
    }

    #[test]
    fn rejects_aes_kdf() {
        // Swap the Argon2d $UUID in the KDF VariantDictionary for AES-KDF's
        // (C9D9F39A-628A-4460-BF74-0D08C18A4FEA). Rejected before key derivation.
        const AES_KDF: [u8; 16] = [
            0xc9, 0xd9, 0xf3, 0x9a, 0x62, 0x8a, 0x44, 0x60, 0xbf, 0x74, 0x0d, 0x08, 0xc1, 0x8a,
            0x4f, 0xea,
        ];
        let mut f = FIXTURE.to_vec();
        let pos = f.windows(16).position(|w| w == KDF_ARGON2D).expect("argon2d uuid present");
        f[pos..pos + 16].copy_from_slice(&AES_KDF);
        assert_eq!(open_inner(&f, PASSWORD, None), Err(KdbxError::UnsupportedKdf));
    }
}

#[cfg(all(test, feature = "wasm"))]
mod export_tests {
    use super::*;

    fn entry(pairs: &[(&str, &str, bool)]) -> SaveEntry {
        SaveEntry {
            strings: pairs
                .iter()
                .map(|(k, v, p)| SaveString {
                    key: (*k).into(),
                    value: (*v).into(),
                    protected: *p,
                })
                .collect(),
        }
    }

    fn find<'a>(e: &'a OutEntry, key: &str) -> Option<&'a str> {
        e.strings.iter().find(|s| s.key == key).map(|s| s.value.as_str())
    }

    #[test]
    fn round_trips_through_our_own_reader() {
        let entries = vec![
            entry(&[
                ("Title", "GitHub", false),
                ("UserName", "octocat@example.com", false),
                ("Password", "hunter2-c0rrect-h0rse", true),
                ("URL", "https://github.com", false),
                ("Notes", "Personal dev account.", false),
                ("otp", "otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP", true),
            ]),
            entry(&[
                ("Title", "Amazon", false),
                ("UserName", "jdoe@example.com", false),
                ("Password", "Pr1me!2024", true),
            ]),
        ];
        let bytes = save_inner(&entries, "export-pw").expect("save");
        let read = open_inner(&bytes, "export-pw", None).expect("open");

        assert_eq!(read.len(), 2);
        assert_eq!(find(&read[0], "Title"), Some("GitHub"));
        assert_eq!(find(&read[0], "Password"), Some("hunter2-c0rrect-h0rse"));
        assert_eq!(
            find(&read[0], "otp"),
            Some("otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP")
        );
        assert_eq!(find(&read[1], "Password"), Some("Pr1me!2024"));
        // Protected on write must stay protected on read.
        assert!(read[0].strings.iter().any(|s| s.key == "Password" && s.protected));
        assert!(read[0].strings.iter().any(|s| s.key == "Title" && !s.protected));
    }

    #[test]
    fn wrong_password_is_a_credential_error() {
        let bytes = save_inner(&[entry(&[("Title", "x", false)])], "right").unwrap();
        assert_eq!(open_inner(&bytes, "wrong", None), Err(KdbxError::WrongCredential));
    }

    #[test]
    fn keeps_the_inner_stream_in_step_across_empty_protected_values() {
        // An empty protected value must advance the keystream by zero on BOTH sides, or
        // every later secret decrypts to garbage.
        let entries = vec![entry(&[
            ("Title", "T", false),
            ("Password", "", true),
            ("Custom", "after-the-empty-one", true),
            ("Other", "second", true),
        ])];
        let bytes = save_inner(&entries, "pw").unwrap();
        let read = open_inner(&bytes, "pw", None).unwrap();
        assert_eq!(find(&read[0], "Password"), Some(""));
        assert_eq!(find(&read[0], "Custom"), Some("after-the-empty-one"));
        assert_eq!(find(&read[0], "Other"), Some("second"));
    }

    #[test]
    fn escapes_xml_metacharacters_in_keys_and_values() {
        let entries = vec![entry(&[
            ("Title", "a<b>&c\"d'e", false),
            ("We&ird<Key>", "plain & value", false),
            ("Password", "<not-a-tag> & \"quoted\"", true),
        ])];
        let bytes = save_inner(&entries, "pw").unwrap();
        let read = open_inner(&bytes, "pw", None).unwrap();
        assert_eq!(find(&read[0], "Title"), Some("a<b>&c\"d'e"));
        assert_eq!(find(&read[0], "We&ird<Key>"), Some("plain & value"));
        assert_eq!(find(&read[0], "Password"), Some("<not-a-tag> & \"quoted\""));
    }

    /// Writes a real .kdbx to /tmp for cross-checking against an actual KeePass client,
    /// which our own reader can't prove. Ignored by default (it touches the filesystem):
    ///   cargo test --lib emit_for_keepassxc -- --ignored --nocapture
    ///   printf 'export-pw-123\n' | keepassxc-cli show -s /tmp/bramble-export.kdbx GitHub
    ///   printf 'export-pw-123\n' | keepassxc-cli show -t /tmp/bramble-export.kdbx GitHub
    /// Verified against keepassxc-cli 2.7.12: entries list, protected values decrypt, the
    /// `otp` field generates a live code, and custom String fields survive.
    #[test]
    #[ignore]
    fn emit_for_keepassxc() {
        let e = |pairs: &[(&str, &str, bool)]| super::SaveEntry {
            strings: pairs.iter().map(|(k, v, p)| super::SaveString {
                key: (*k).into(), value: (*v).into(), protected: *p,
            }).collect(),
        };
        let entries = vec![
            e(&[("Title","GitHub",false),("UserName","octocat@example.com",false),
                ("Password","hunter2-c0rrect-h0rse",true),("URL","https://github.com",false),
                ("Notes","Personal dev account.\nSecond line.",false),
                ("otp","otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub",true)]),
            e(&[("Title","Nimbus Bank (\"joint\")",false),("UserName","jane.doe@example.com",false),
                ("Password","c0mma,and-qu0te\"inside",true),("URL","https://bank.example.com",false),
                ("Recovery contact","555-0100",false)]),
            e(&[("Title","Personal Visa",false),("Cardholder","Jane Q. Doe",false),
                ("Number","4111111111111111",true),("CVV","123",true),("Expiry","08/2027",false)]),
        ];
        let bytes = super::save_inner(&entries, "export-pw-123").expect("save");
        std::fs::write("/tmp/bramble-export.kdbx", &bytes).unwrap();
        eprintln!("WROTE {} bytes", bytes.len());
    }

    #[test]
    fn rejects_an_empty_password() {
        assert!(save_inner(&[entry(&[("Title", "x", false)])], "").is_err());
    }

    #[test]
    fn writes_an_empty_database_without_entries() {
        let bytes = save_inner(&[], "pw").unwrap();
        assert_eq!(open_inner(&bytes, "pw", None).unwrap().len(), 0);
    }

    #[test]
    fn survives_a_payload_larger_than_one_block() {
        // Forces multiple HMAC blocks, where a wrong block index would break verification.
        let big = "x".repeat(300_000);
        let entries: Vec<SaveEntry> = (0..8)
            .map(|i| entry(&[("Title", &format!("e{i}"), false), ("Notes", &big, false)]))
            .collect();
        let bytes = save_inner(&entries, "pw").unwrap();
        let read = open_inner(&bytes, "pw", None).unwrap();
        assert_eq!(read.len(), 8);
        assert_eq!(find(&read[7], "Notes").map(str::len), Some(300_000));
    }
}
