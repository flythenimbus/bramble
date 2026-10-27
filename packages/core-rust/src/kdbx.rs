//! KDBX4 import and export: KeePass databases, attachments included, in WASM and natively.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use cbc::cipher::BlockEncryptMut;
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use chacha20::cipher::StreamCipher;
use chacha20::ChaCha20;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use hmac::{Hmac, Mac};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256, Sha512};
use std::io::Read;
use std::io::Write;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
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
/// Synthetic String key carrying KeePass's `<Tags>` element across the JS/FFI boundary.
/// A pair rather than a new field on `OutEntry`, which is a `uniffi::Record` on the FFI
/// surface: adding to it would regenerate every Swift and Kotlin binding for one string.
const TAGS_KEY: &str = "Tags";
/// Synthetic String key carrying the entry's KeePass group path, which the importer maps
/// to tags. Groups are the only organisation a KeePass database has.
const GROUP_KEY: &str = "Group";

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
    /// KDF parameters from the file exceed our safety ceilings (OOM / hang guard). Carries the
    /// numbers so a bug report says which setting was too high instead of just "it failed".
    KdfTooExpensive { mem_kib: u64, iterations: u64 },
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
            KdbxError::KdfTooExpensive { mem_kib, iterations } => {
                format!("KDBX_KDF_TOO_EXPENSIVE:{mem_kib}KiB/{iterations}")
            }
            KdbxError::Corrupt(s) => format!("KDBX_CORRUPT:{s}"),
        }
    }
}

type Res<T> = Result<T, KdbxError>;

/// One imported entry: its KeePass String key/value pairs, protected values
/// already decrypted, and the attachments it names. JS maps these to `EntryData`.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct OutEntry {
    pub strings: Vec<OutString>,
    pub binaries: Vec<OutBinary>,
}
/// An entry's attachment: its name on that entry, and which of the database's attachments it
/// is. KeePass stores each attachment once and lets entries share it.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct OutBinary {
    pub name: String,
    pub index: u32,
}
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct OutString {
    pub key: String,
    pub value: String,
    /// True for KeePass "Protected" fields so the JS layer keeps them hidden.
    pub protected: bool,
}

/// WASM entry point. `keyfile` is the raw key-file bytes, if any. Returns
/// `{ entries, attachments }`, each attachment a `Uint8Array` the entries refer to by index.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub fn open_kdbx4(
    file: &[u8],
    password: &str,
    keyfile: Option<Box<[u8]>>,
) -> Result<JsValue, JsError> {
    let (entries, attachments) =
        open_full(file, password, keyfile.as_deref()).map_err(|e| JsError::new(&e.code()))?;
    let entries = serde_wasm_bindgen::to_value(&entries)
        .map_err(|e| JsError::new(&format!("KDBX_SERIALIZE:{e}")))?;
    // Byte arrays as Uint8Array, not through serde, which would make each an array of numbers.
    let list = js_sys::Array::new();
    for a in &attachments {
        list.push(&js_sys::Uint8Array::from(a.as_slice()));
    }
    let out = js_sys::Object::new();
    js_sys::Reflect::set(&out, &"entries".into(), &entries)
        .and_then(|_| js_sys::Reflect::set(&out, &"attachments".into(), &list))
        .map_err(|_| JsError::new("KDBX_SERIALIZE:result"))?;
    Ok(out.into())
}

/// Native entry point: uniffi (Swift/Kotlin), and bare for the desktop shell, which links
/// this crate as an ordinary cargo dependency and re-exposes it as a Tauri command. Same
/// core as the WASM path; the `KdbxError` code becomes the `CryptoError` message so the TS
/// layer's switch on the code string (e.g. `KDBX_WRONG_CREDENTIAL`) works identically
/// across layers.
///
/// Attachments are written into `dir` (created if absent, owner-only), one file each, because a
/// database's attachments can be far larger than is sensible to hand across a bridge as bytes;
/// the caller seals them from there and deletes the folder. Put it where decrypted copies are
/// swept on lock, so nothing survives a session that ends mid-import.
#[cfg(any(feature = "ffi", feature = "native"))]
#[cfg_attr(feature = "ffi", uniffi::export)]
pub fn open_kdbx4(
    file: Vec<u8>,
    password: String,
    keyfile: Option<Vec<u8>>,
    dir: String,
) -> Result<OpenedKdbx, crate::CryptoError> {
    let (entries, attachments) =
        open_full(&file, &password, keyfile.as_deref()).map_err(|e| crate::err(e.code()))?;
    let dir = std::path::Path::new(&dir);
    let written = write_attachments(dir, &attachments)
        .map_err(|e| crate::err(format!("KDBX_ATTACHMENT_WRITE:{e}")))?;
    Ok(OpenedKdbx {
        entries,
        attachments: written,
    })
}

/// A database opened natively: its entries, and its attachments as files the entries refer to
/// by index.
#[cfg(any(feature = "ffi", feature = "native"))]
#[derive(Serialize, Debug)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct OpenedKdbx {
    pub entries: Vec<OutEntry>,
    pub attachments: Vec<KdbxAttachmentFile>,
}
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(feature = "ffi", derive(uniffi::Record))]
pub struct KdbxAttachmentFile {
    pub path: String,
    pub size: u64,
}

/// Write each attachment to its own owner-only file in `dir`. Built in every feature set so the
/// test runs with the rest; only the native bindings call it.
#[cfg_attr(not(any(feature = "ffi", feature = "native")), allow(dead_code))]
fn write_attachments(
    dir: &std::path::Path,
    attachments: &[Zeroizing<Vec<u8>>],
) -> std::io::Result<Vec<KdbxAttachmentFile>> {
    use std::io::Write as _;
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut out = Vec::with_capacity(attachments.len());
    for (i, bytes) in attachments.iter().enumerate() {
        let path = dir.join(format!("attachment-{i}"));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?.write_all(bytes)?;
        let path = path
            .to_str()
            .ok_or_else(|| std::io::Error::other("attachment path is not UTF-8"))?
            .to_owned();
        out.push(KdbxAttachmentFile {
            path,
            size: bytes.len() as u64,
        });
    }
    Ok(out)
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
    // Reject implausible parameters from the untrusted file before allocating: a malicious
    // .kdbx could request terabytes of memory or millions of passes (OOM / hang).
    //
    // Argon2's cost is roughly memory x passes, so the budget bounds the PRODUCT. Capping
    // passes on their own was the wrong shape (#78): it rejected 1 MiB over 3000 rounds, about
    // a second of work and exactly what KeePassXC's one-second benchmark produces at low memory
    // settings, while admitting 1 GiB over 64 rounds, twenty times the work. The budget is set
    // at that former worst case, so nothing that used to open stops opening.
    const MAX_KDF_MEM_BYTES: u64 = 1 << 30; // 1 GiB, bounding the allocation itself
    const MAX_KDF_PARALLELISM: u32 = 64;
    const MAX_KDF_WORK_KIB_PASSES: u64 = 1 << 26; // 1 GiB x 64 passes
    let mem_kib_u64 = kdf.mem_bytes / 1024;
    // `.max(1)` so a file declaring under 1 KiB cannot buy unlimited passes for free; argon2
    // rejects anything under 8 KiB below anyway.
    let work = mem_kib_u64.max(1).saturating_mul(kdf.iterations);
    if kdf.mem_bytes > MAX_KDF_MEM_BYTES
        || kdf.parallelism > MAX_KDF_PARALLELISM
        || work > MAX_KDF_WORK_KIB_PASSES
    {
        return Err(KdbxError::KdfTooExpensive {
            mem_kib: mem_kib_u64,
            iterations: kdf.iterations,
        });
    }
    let mem_kib = u32::try_from(mem_kib_u64).map_err(|_| KdbxError::Corrupt("KDF mem"))?;
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

/// Open a KDBX4 database, entries only. For the tests, which mostly look at fields.
#[cfg(test)]
pub fn open_inner(file: &[u8], password: &str, keyfile: Option<&[u8]>) -> Res<Vec<OutEntry>> {
    Ok(open_full(file, password, keyfile)?.0)
}

/// The database's attachments, in inner-header order, which is what entries' `index` counts.
type Attachments = Vec<Zeroizing<Vec<u8>>>;

/// Open a KDBX4 database: entries with protected values decrypted, and its attachments.
pub fn open_full(
    file: &[u8],
    password: &str,
    keyfile: Option<&[u8]>,
) -> Res<(Vec<OutEntry>, Attachments)> {
    let inner_payload = open_payload(file, password, keyfile)?;

    // Inner header (KDBX4): inner stream cipher id + key, then each attachment.
    let mut ic = Cursor::new(&inner_payload);
    let mut inner_stream_id = 0u32;
    let mut inner_stream_key = Vec::new();
    let mut attachments: Attachments = Vec::new();
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
            // A flag byte (memory protection, which means nothing here), then the bytes.
            3 => {
                let (_flags, bytes) = data
                    .split_first()
                    .ok_or(KdbxError::Corrupt("empty attachment field"))?;
                attachments.push(Zeroizing::new(bytes.to_vec()));
            }
            _ => {}
        }
    }
    if inner_stream_id != 3 {
        return Err(KdbxError::UnsupportedStream); // KDBX4 expects ChaCha20
    }
    let xml = &inner_payload[ic.p..];

    Ok((parse_inner_xml(xml, &inner_stream_key)?, attachments))
}

/// Authenticate and decrypt a KDBX4 file down to its inner payload: the inner header, then XML.
fn open_payload(file: &[u8], password: &str, keyfile: Option<&[u8]>) -> Res<Zeroizing<Vec<u8>>> {
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

    match compression {
        0 => Ok(payload),
        1 => {
            let mut gz = GzDecoder::new(&payload[..]);
            let mut out = Zeroizing::new(Vec::new());
            gz.read_to_end(&mut out).map_err(|_| KdbxError::Corrupt("gzip"))?;
            Ok(out)
        }
        _ => Err(KdbxError::Corrupt("compression flag")),
    }
}

/// Record the attachment an entry's `<Binary>` names: `name` on the innermost entry, by `Ref`.
fn push_binary_ref(
    value: &quick_xml::events::BytesStart,
    name: &str,
    entry_stack: &mut [(Vec<OutString>, Vec<OutBinary>)],
) -> Res<()> {
    let index = value
        .attributes()
        .flatten()
        .find(|a| a.key.as_ref() == b"Ref")
        .and_then(|a| std::str::from_utf8(&a.value).ok()?.parse::<u32>().ok())
        .ok_or(KdbxError::Corrupt("attachment reference"))?;
    if let Some(frame) = entry_stack.last_mut() {
        frame.1.push(OutBinary {
            name: name.to_owned(),
            index,
        });
    }
    Ok(())
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
    let mut entry_stack: Vec<(Vec<OutString>, Vec<OutBinary>)> = Vec::new();
    // Inside an entry's <Binary>: its <Key> names the attachment and its <Value Ref> says which.
    let mut in_binary = false;
    let mut group_names: Vec<String> = Vec::new();
    let mut history_depth = 0usize;

    #[derive(PartialEq)]
    enum Mode {
        None,
        Key,
        Value,
        GroupName,
        Tags,
    }
    let mut mode = Mode::None;
    let mut protected = false;
    let mut cur_key = String::new();
    let mut cur_val = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"Group" => group_names.push(String::new()),
                b"Entry" => entry_stack.push((Vec::new(), Vec::new())),
                b"Binary" if !entry_stack.is_empty() => in_binary = true,
                b"Value" if in_binary => {
                    push_binary_ref(&e, &cur_key, &mut entry_stack)?;
                    mode = Mode::None;
                }
                b"History" => history_depth += 1,
                // Only an entry's own <Tags>; the Meta block has one too.
                b"Tags" if !entry_stack.is_empty() => {
                    mode = Mode::Tags;
                    cur_val.clear();
                }
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
                    Mode::Value | Mode::Tags => cur_val = txt,
                    Mode::GroupName => {
                        if let Some(n) = group_names.last_mut() {
                            *n = txt;
                        }
                    }
                    Mode::None => {}
                }
            }
            // `<Value Ref="0"/>`, the way KeePass writes an entry's reference to an attachment.
            Ok(Event::Empty(e)) if in_binary && e.name().as_ref() == b"Value" => {
                push_binary_ref(&e, &cur_key, &mut entry_stack)?;
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"Binary" => in_binary = false,
                b"Value" if in_binary => {}
                b"Value" => {
                    let value = if protected && !cur_val.is_empty() {
                        let mut raw = B64.decode(cur_val.as_bytes()).map_err(|_| KdbxError::Corrupt("b64"))?;
                        stream.apply_keystream(&mut raw);
                        String::from_utf8(raw).map_err(|_| KdbxError::Corrupt("protected utf8"))?
                    } else {
                        cur_val.clone()
                    };
                    if let Some(frame) = entry_stack.last_mut() {
                        frame.0.push(OutString {
                            key: cur_key.clone(),
                            value,
                            protected,
                        });
                    }
                    mode = Mode::None;
                }
                b"Key" | b"Name" => mode = Mode::None,
                b"Tags" => {
                    if mode == Mode::Tags {
                        if let Some(frame) = entry_stack.last_mut() {
                            if !cur_val.is_empty() {
                                frame.0.push(OutString {
                                    key: TAGS_KEY.to_string(),
                                    value: cur_val.clone(),
                                    protected: false,
                                });
                            }
                        }
                        mode = Mode::None;
                    }
                }
                b"History" => history_depth = history_depth.saturating_sub(1),
                b"Group" => {
                    group_names.pop();
                }
                b"Entry" => {
                    if let Some((mut frame, binaries)) = entry_stack.pop() {
                        // Emit only top-level entries: not History, not Recycle Bin.
                        let in_recycle = group_names.iter().any(|n| n == RECYCLE_BIN);
                        if history_depth == 0 && entry_stack.is_empty() && !in_recycle {
                            // The group path, so the importer can turn a database's folder
                            // structure into tags instead of discarding it. The outermost
                            // group is the database root and names the file, not a folder.
                            let path = group_names
                                .iter()
                                .skip(1)
                                .filter(|n| !n.is_empty())
                                .cloned()
                                .collect::<Vec<_>>()
                                .join("/");
                            if !path.is_empty() {
                                frame.push(OutString {
                                    key: GROUP_KEY.to_string(),
                                    value: path,
                                    protected: false,
                                });
                            }
                            entries.push(OutEntry {
                                strings: frame,
                                binaries,
                            });
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
const OUT_KDF_MEM_BYTES: u64 = 64 * 1024 * 1024;
const OUT_KDF_ITERATIONS: u64 = 3;
const OUT_KDF_PARALLELISM: u32 = 1;
const ARGON2_V13: u32 = 0x13;
/// KeePass's own payload block size. A single huge block is legal but unconventional.
const BLOCK_SIZE: usize = 1024 * 1024;

/// One entry to write, as KeePass String pairs. The read-side mirror of `OutEntry`; JS
/// builds these from `EntryData` so the field naming stays in the TS layer.
#[derive(Deserialize, Clone)]
pub struct SaveEntry {
    pub strings: Vec<SaveString>,
    /// Attachments, by the index `Writer::begin_binary` gave each one.
    #[serde(default)]
    pub binaries: Vec<SaveBinary>,
}
#[derive(Deserialize, Clone)]
pub struct SaveString {
    pub key: String,
    pub value: String,
    /// Written as `Protected="True"` and encrypted with the inner stream.
    pub protected: bool,
}
/// An entry's reference to one attachment in the inner header. `name` is unique per entry.
#[derive(Deserialize, Clone)]
pub struct SaveBinary {
    pub name: String,
    pub index: u32,
}

fn rng(buf: &mut [u8]) -> Res<()> {
    crate::random_bytes(buf).map_err(|_| KdbxError::Corrupt("rng"))
}

/// `[id:u8][len:u32][data]`, the shape of both the outer and inner header fields.
fn push_field(out: &mut Vec<u8>, id: u8, data: &[u8]) {
    out.push(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
}

/// `[type:u8][klen:u32][key][vlen:u32][val]`, one VariantDictionary item.
fn push_variant(out: &mut Vec<u8>, ty: u8, key: &[u8], val: &[u8]) {
    out.push(ty);
    out.extend_from_slice(&(key.len() as u32).to_le_bytes());
    out.extend_from_slice(key);
    out.extend_from_slice(&(val.len() as u32).to_le_bytes());
    out.extend_from_slice(val);
}

/// KDF VariantDictionary for Argon2id. Types: 0x04 u32, 0x05 u64, 0x42 byte array.
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
fn build_xml(entries: &[SaveEntry], inner_key: &[u8], binary_count: u32) -> Res<Vec<u8>> {
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
        // KeePass models tags as a first-class <Tags> element, not a String pair, so a
        // string keyed TAGS_KEY is lifted out and written as one. Carrying it across the
        // JS boundary as an ordinary pair keeps `SaveEntry` (a uniffi Record on the read
        // side's mirror) unchanged, so the generated Swift/Kotlin bindings don't churn.
        if let Some(tags) = e
            .strings
            .iter()
            .find(|s| s.key == TAGS_KEY && !s.value.is_empty())
        {
            x.push_str("<Tags>");
            x.push_str(&quick_xml::escape::escape(&tags.value));
            x.push_str("</Tags>");
        }
        for s in &e.strings {
            if s.key.is_empty() || s.key == TAGS_KEY {
                continue; // no Key means nowhere to land on re-import; Tags went above
            }
            x.push_str("<String><Key>");
            x.push_str(&quick_xml::escape::escape(&s.key));
            x.push_str("</Key>");
            if s.protected {
                let mut raw = s.value.clone().into_bytes();
                stream.apply_keystream(&mut raw);
                x.push_str(&format!(
                    r#"<Value Protected="True">{}</Value>"#,
                    B64.encode(&raw)
                ));
            } else {
                x.push_str("<Value>");
                x.push_str(&quick_xml::escape::escape(&s.value));
                x.push_str("</Value>");
            }
            x.push_str("</String>");
        }
        for b in &e.binaries {
            // A reference to an attachment that was never written would open as a missing
            // file in every KeePass client: refuse the export rather than write one.
            if b.index >= binary_count {
                return Err(KdbxError::Corrupt("attachment reference out of range"));
            }
            x.push_str("<Binary><Key>");
            x.push_str(&quick_xml::escape::escape(&b.name));
            x.push_str(&format!(r#"</Key><Value Ref="{}"/></Binary>"#, b.index));
        }
        x.push_str("</Entry>");
    }
    x.push_str("</Group></Root></KeePassFile>");
    Ok(x.into_bytes())
}

/// The encrypted half of the payload: AES-256-CBC applied as bytes arrive, the ciphertext cut
/// into HMAC blocks as each fills, and the framed blocks queued for the caller to take. Fed by
/// the gzip encoder, so nothing past one block is ever held.
struct BlockSink {
    enc: Aes256CbcEnc,
    /// Plaintext short of a whole AES block, carried to the next write.
    partial: Zeroizing<Vec<u8>>,
    /// Ciphertext short of a whole HMAC block.
    block: Vec<u8>,
    index: u64,
    hmac_base: Zeroizing<[u8; 64]>,
    out: Vec<u8>,
}

impl BlockSink {
    /// One HMAC block: its MAC over index, length and data, then length and data.
    fn frame(&mut self, len: usize) {
        let bk = sha512_block_key(self.index, self.hmac_base.as_slice());
        let mut m = HmacSha256::new_from_slice(&bk).unwrap();
        m.update(&self.index.to_le_bytes());
        m.update(&(len as u32).to_le_bytes());
        m.update(&self.block[..len]);
        self.out.extend_from_slice(&m.finalize().into_bytes());
        self.out.extend_from_slice(&(len as u32).to_le_bytes());
        self.out.extend_from_slice(&self.block[..len]);
        self.block.drain(..len);
        self.index += 1;
    }

    fn encrypt(&mut self, mut plain: Zeroizing<Vec<u8>>) {
        for b in plain.chunks_exact_mut(16) {
            self.enc
                .encrypt_block_mut(cbc::cipher::generic_array::GenericArray::from_mut_slice(b));
        }
        self.block.extend_from_slice(&plain);
        while self.block.len() >= BLOCK_SIZE {
            self.frame(BLOCK_SIZE);
        }
    }

    /// PKCS#7 the tail, frame what is left, and end the stream with the zero-length block
    /// whose HMAC still counts.
    fn finish(mut self) -> Vec<u8> {
        let pad = 16 - self.partial.len() % 16;
        let mut tail = Zeroizing::new(std::mem::take(&mut *self.partial));
        tail.extend(std::iter::repeat_n(pad as u8, pad));
        self.encrypt(tail);
        if !self.block.is_empty() {
            let len = self.block.len();
            self.frame(len);
        }
        self.frame(0);
        self.out
    }
}

impl Write for BlockSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.partial.extend_from_slice(buf);
        let whole = self.partial.len() / 16 * 16;
        if whole > 0 {
            let ready = Zeroizing::new(self.partial.drain(..whole).collect::<Vec<u8>>());
            self.encrypt(ready);
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A KDBX4 database written front to back, so its attachments never have to be held at once.
///
/// The format orders it: the inner header carries every attachment, then the XML names which
/// entry holds which. So attachments go in first (`begin_binary`, `write_binary`), then
/// `finish` writes the entries. `take` hands over the bytes ready so far, in order, at any point.
pub struct Writer {
    gz: GzEncoder<BlockSink>,
    inner_key: Zeroizing<[u8; 64]>,
    header: Vec<u8>,
    binaries: u32,
    /// Bytes the open attachment still owes.
    owed: u64,
}

impl Writer {
    /// Derive the file's keys from `password` (the slow part: Argon2id) and write the header.
    pub fn new(password: &str) -> Res<Self> {
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

        let mut out = header.clone();
        out.extend_from_slice(&Sha256::digest(&header));
        let hdr_key = sha512_block_key(u64::MAX, keys.hmac_base.as_slice());
        let mut mac = HmacSha256::new_from_slice(&hdr_key).unwrap();
        mac.update(&header);
        out.extend_from_slice(&mac.finalize().into_bytes());

        let sink = BlockSink {
            enc: Aes256CbcEnc::new_from_slices(keys.cipher_key.as_slice(), &enc_iv)
                .map_err(|_| KdbxError::Corrupt("AES key/iv"))?,
            partial: Zeroizing::new(Vec::new()),
            block: Vec::new(),
            index: 0,
            hmac_base: keys.hmac_base,
            out: Vec::new(),
        };
        // Fast rather than default: an export can carry gigabytes of attachments, most of them
        // already compressed, and the XML is small either way.
        let mut writer = Self {
            gz: GzEncoder::new(sink, Compression::fast()),
            inner_key,
            header: out,
            binaries: 0,
            owed: 0,
        };
        // Inner header: stream id 3 = ChaCha20, then its key. Attachments follow.
        let mut fields = Vec::new();
        push_field(&mut fields, 1, &3u32.to_le_bytes());
        push_field(&mut fields, 2, writer.inner_key.as_slice());
        writer.write_inner(&fields)?;
        Ok(writer)
    }

    fn write_inner(&mut self, bytes: &[u8]) -> Res<()> {
        self.gz
            .write_all(bytes)
            .map_err(|_| KdbxError::Corrupt("gzip write"))
    }

    /// Start an attachment of exactly `len` bytes. Returns the index entries refer to it by.
    pub fn begin_binary(&mut self, len: u64) -> Res<u32> {
        if self.owed != 0 {
            return Err(KdbxError::Corrupt("the previous attachment is unfinished"));
        }
        // One header field: a flag byte, then the bytes. The field length is a u32.
        let field_len = u32::try_from(len + 1)
            .map_err(|_| KdbxError::Corrupt("attachment too large for KDBX"))?;
        let mut head = vec![3u8];
        head.extend_from_slice(&field_len.to_le_bytes());
        head.push(0x01); // protected in memory, as KeePass does for attachments it is handed
        self.write_inner(&head)?;
        self.owed = len;
        let index = self.binaries;
        self.binaries += 1;
        Ok(index)
    }

    /// More of the open attachment. Never more than it was declared to hold.
    pub fn write_binary(&mut self, bytes: &[u8]) -> Res<()> {
        let n = bytes.len() as u64;
        if n > self.owed {
            return Err(KdbxError::Corrupt("attachment is longer than declared"));
        }
        self.write_inner(bytes)?;
        self.owed -= n;
        Ok(())
    }

    /// The bytes ready so far, in file order. Take them between writes and the file is never
    /// held whole.
    pub fn take(&mut self) -> Vec<u8> {
        let mut ready = std::mem::take(&mut self.header);
        ready.append(&mut self.gz.get_mut().out);
        ready
    }

    /// Write the entries and close the file. Returns the last of its bytes.
    pub fn finish(mut self, entries: &[SaveEntry]) -> Res<Vec<u8>> {
        if self.owed != 0 {
            return Err(KdbxError::Corrupt("an attachment is shorter than declared"));
        }
        self.write_inner(&[0, 0, 0, 0, 0])?; // end of inner header
        let xml = Zeroizing::new(build_xml(
            entries,
            self.inner_key.as_slice(),
            self.binaries,
        )?);
        self.write_inner(&xml)?;
        let mut ready = std::mem::take(&mut self.header);
        let sink = self
            .gz
            .finish()
            .map_err(|_| KdbxError::Corrupt("gzip finish"))?;
        ready.extend(sink.finish());
        Ok(ready)
    }
}

/// Write a KDBX4 database holding `entries` in one call, for the tests. The app streams.
#[cfg(test)]
pub fn save_inner(entries: &[SaveEntry], password: &str) -> Res<Vec<u8>> {
    let mut w = Writer::new(password)?;
    let mut out = w.take();
    out.extend(w.finish(entries)?);
    Ok(out)
}

/// One attachment to export natively: its sealed blob where it sits on disk, the key fields to
/// open it, and where it goes (the entry index in `entries`, and its name there).
#[cfg_attr(not(any(feature = "ffi", feature = "native")), allow(dead_code))]
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KdbxExportFile {
    pub blob_path: String,
    pub wrapped_fek: String,
    pub fek_iv: String,
    pub nonce_prefix: String,
    /// Sealed length: the blob must be exactly this, or it hasn't arrived whole.
    pub size: u64,
    pub entry: u32,
    pub name: String,
}

/// Write a KDBX4 database holding `entries` and every file in `files` to `out`, a piece at a
/// time, for the desktop app and the phones. Returns the file's length.
///
/// Whole or not at all, as a backup is: every blob is checked against its recorded size, and
/// every file's stream keyed under the VEK in the slot now, before a byte is written. The file
/// is written beside `out` and renamed into place only once complete, so a failed export never
/// leaves a file under the name the caller asked for.
#[cfg_attr(not(any(feature = "ffi", feature = "native")), allow(dead_code))]
pub fn save_to_path(
    entries: &[SaveEntry],
    password: &str,
    files: &[KdbxExportFile],
    out: &std::path::Path,
) -> Result<u64, String> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    for f in files {
        if f.entry as usize >= entries.len() {
            return Err("an attachment's entry is not in the export".into());
        }
        let held = std::fs::metadata(&f.blob_path).map(|m| m.len()).ok();
        if held != Some(f.size) {
            return Err("an attachment hasn't reached this device yet".into());
        }
    }
    let mut streams = files
        .iter()
        .map(|f| {
            crate::begin_open_stream_core(&f.wrapped_fek, &f.fek_iv, &f.nonce_prefix, f.size)
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;

    let name = out
        .file_name()
        .ok_or("export path has no file name")?
        .to_string_lossy();
    let temp = out.with_file_name(format!(".{name}.partial"));
    let written = (|| -> Result<u64, String> {
        let io = |e: std::io::Error| format!("export: {}", e.kind());
        let mut file = std::fs::File::create(&temp).map_err(io)?;
        let mut w = Writer::new(password).map_err(|e| e.code())?;
        file.write_all(&w.take()).map_err(io)?;
        let mut refs: Vec<Vec<SaveBinary>> = vec![Vec::new(); entries.len()];
        for (f, stream) in files.iter().zip(streams.iter_mut()) {
            let index = w
                .begin_binary(stream.plaintext_len())
                .map_err(|e| e.code())?;
            let mut blob = std::fs::File::open(&f.blob_path).map_err(io)?;
            while let Some((offset, len)) = stream.next_range() {
                let mut sealed = vec![0u8; len as usize];
                blob.seek(SeekFrom::Start(offset)).map_err(io)?;
                blob.read_exact(&mut sealed).map_err(io)?;
                let plain = stream.open_next(&sealed).map_err(|e| e.to_string())?;
                w.write_binary(&plain).map_err(|e| e.code())?;
                file.write_all(&w.take()).map_err(io)?;
            }
            refs[f.entry as usize].push(SaveBinary {
                name: f.name.clone(),
                index,
            });
        }
        let entries: Vec<SaveEntry> = entries
            .iter()
            .zip(refs)
            .map(|(e, binaries)| SaveEntry {
                strings: e.strings.clone(),
                binaries,
            })
            .collect();
        file.write_all(&w.finish(&entries).map_err(|e| e.code())?)
            .map_err(io)?;
        file.sync_all().map_err(io)?;
        file.metadata().map(|m| m.len()).map_err(io)
    })();
    match written {
        Ok(len) => {
            std::fs::rename(&temp, out).map_err(|e| format!("export: {}", e.kind()))?;
            Ok(len)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            Err(e)
        }
    }
}

/// The phones' entry point: `save_to_path` with its arguments as JSON (`SaveEntry[]` and
/// `KdbxExportFile[]`), so the Swift and Kotlin plugins pass through what JS sent rather than
/// rebuilding each record by hand.
#[cfg(feature = "ffi")]
#[uniffi::export]
pub fn save_kdbx4(
    entries_json: String,
    password: String,
    files_json: String,
    out_path: String,
) -> Result<u64, crate::CryptoError> {
    let entries: Vec<SaveEntry> =
        serde_json::from_str(&entries_json).map_err(|e| crate::err(format!("KDBX_INPUT:{e}")))?;
    let files: Vec<KdbxExportFile> =
        serde_json::from_str(&files_json).map_err(|e| crate::err(format!("KDBX_INPUT:{e}")))?;
    save_to_path(&entries, &password, &files, std::path::Path::new(&out_path)).map_err(crate::err)
}

/// The writer, for JS: attachments streamed in from the vault's store, the file streamed out.
#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct KdbxWriter {
    w: Option<Writer>,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl KdbxWriter {
    #[wasm_bindgen(constructor)]
    pub fn new(password: &str) -> Result<KdbxWriter, JsError> {
        let w = Writer::new(password).map_err(|e| JsError::new(&e.code()))?;
        Ok(KdbxWriter { w: Some(w) })
    }

    fn writer(&mut self) -> Result<&mut Writer, JsError> {
        self.w
            .as_mut()
            .ok_or_else(|| JsError::new("KDBX_CORRUPT:writer finished"))
    }

    /// `len` as a number rather than a BigInt, since JS has a size as one.
    pub fn begin_binary(&mut self, len: f64) -> Result<u32, JsError> {
        if !(len >= 0.0 && len.fract() == 0.0 && len <= 9007199254740991.0) {
            return Err(JsError::new("KDBX_CORRUPT:attachment length"));
        }
        self.writer()?
            .begin_binary(len as u64)
            .map_err(|e| JsError::new(&e.code()))
    }

    pub fn write_binary(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.writer()?
            .write_binary(bytes)
            .map_err(|e| JsError::new(&e.code()))
    }

    pub fn take(&mut self) -> Result<Vec<u8>, JsError> {
        Ok(self.writer()?.take())
    }

    /// `entries` as `SaveEntry` objects, binaries referring to the indices handed out above.
    pub fn finish(&mut self, entries: JsValue) -> Result<Vec<u8>, JsError> {
        let entries: Vec<SaveEntry> = serde_wasm_bindgen::from_value(entries)
            .map_err(|e| JsError::new(&format!("KDBX_INPUT:{e}")))?;
        let w = self
            .w
            .take()
            .ok_or_else(|| JsError::new("KDBX_CORRUPT:writer finished"))?;
        w.finish(&entries).map_err(|e| JsError::new(&e.code()))
    }
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
                                                // Two entries written by our writer (the CLI only creates KDBX3), then every attachment
                                                // added by keepassxc-cli 2.7.12 attachment-import, which rewrites the whole file as KDBX4:
                                                // the attachments and XML are KeePassXC's. Passport holds scan.bin and note.txt; Deed holds
                                                // copy.txt, note.txt's content again, so KeePassXC stores it once and both point at it.
    const ATTACH_DB: &[u8] = fixture!("attachments.kdbx");
    const ATTACH_SCAN: &[u8] = fixture!("attachments-scan.bin");
    const ATTACH_NOTE: &[u8] = fixture!("attachments-note.txt");
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
    fn reads_keepassxc_attachments_and_which_entry_holds_each() {
        let (entries, attachments) = open_full(ATTACH_DB, "attach-pass", None).expect("open");
        let bytes_of = |title: &str, name: &str| {
            let b = by_title(&entries, title)
                .binaries
                .iter()
                .find(|b| b.name == name)
                .unwrap_or_else(|| panic!("{title} has no {name}"));
            attachments[b.index as usize].to_vec()
        };
        assert_eq!(bytes_of("Passport", "scan.bin"), ATTACH_SCAN);
        assert_eq!(bytes_of("Passport", "note.txt"), ATTACH_NOTE);
        assert_eq!(bytes_of("Deed", "copy.txt"), ATTACH_NOTE);
        assert_eq!(attachments.len(), 2, "shared content is stored once");
        // A reference is not a field: no String pair named after an attachment.
        let passport = by_title(&entries, "Passport");
        assert!(passport
            .strings
            .iter()
            .all(|s| s.key != "scan.bin" && s.key != "note.txt"));
    }

    #[test]
    fn a_database_without_attachments_has_none() {
        let (entries, attachments) = open_full(FIXTURE, PASSWORD, None).unwrap();
        assert!(attachments.is_empty());
        assert!(entries.iter().all(|e| e.binaries.is_empty()));
    }

    #[test]
    fn writes_each_attachment_to_its_own_owner_only_file() {
        let dir = std::env::temp_dir().join(format!("bramble-kdbx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (_, attachments) = open_full(ATTACH_DB, "attach-pass", None).unwrap();
        let written = write_attachments(&dir.join("import"), &attachments).unwrap();
        assert_eq!(written.len(), attachments.len());
        for (file, bytes) in written.iter().zip(&attachments) {
            assert_eq!(std::fs::read(&file.path).unwrap(), bytes.as_slice());
            assert_eq!(file.size, bytes.len() as u64);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&file.path).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{}", file.path);
            }
        }
        // A second write into the same folder refuses rather than overwriting.
        assert!(write_attachments(&dir.join("import"), &attachments).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
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
        let too_expensive =
            |m, i, p| matches!(argon2_transform(&mk(m, i, p), &composite), Err(KdbxError::KdfTooExpensive { .. }));

        // In-bounds (tiny) params derive without tripping the safety gate.
        assert!(argon2_transform(&mk(64 * 1024, 1, 1), &composite).is_ok());
        // Many passes over little memory: the #78 shape, which the old per-axis ceiling of 64
        // passes rejected. 300 rather than the reported 3000 because this actually derives, and
        // argon2 in a debug build costs ~20s at 3000; 300 still clears the old ceiling five times
        // over, so it regresses the same way. is_ok rather than "not too expensive" so the
        // derivation has to succeed, not merely clear the gate and fail inside argon2.
        assert!(argon2_transform(&mk(1024 * 1024, 300, 2), &composite).is_ok());
        // The reported parameters themselves, gate only: 1 MiB over 3000 passes is inside budget.
        assert!(1024u64 * 3000 < (1 << 26));
        // Memory and parallelism keep their own ceilings: one bounds the allocation, the other
        // the thread count, and neither is captured by the work product.
        assert!(too_expensive(2 << 30, 1, 1));
        assert!(too_expensive(64 * 1024, 1, 1000));
        // Over the work budget: 1 GiB over 65 passes is more than the former worst case.
        assert!(too_expensive(1 << 30, 65, 1));
        // A tiny-memory file cannot buy unlimited passes.
        assert!(too_expensive(512, 1 << 27, 1));
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

#[cfg(test)]
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
            binaries: vec![],
        }
    }

    /// The attachments in a file's inner header, in order, flag byte stripped; and the XML.
    fn binaries_and_xml(file: &[u8], password: &str) -> (Vec<Vec<u8>>, String) {
        let payload = open_payload(file, password, None).expect("open payload");
        let mut c = Cursor::new(&payload);
        let mut binaries = Vec::new();
        loop {
            let id = c.u8().unwrap();
            let len = c.u32().unwrap() as usize;
            let data = c.take(len).unwrap();
            match id {
                0 => break,
                3 => binaries.push(data[1..].to_vec()),
                _ => {}
            }
        }
        (
            binaries,
            String::from_utf8(payload[c.p..].to_vec()).unwrap(),
        )
    }

    fn body(len: usize, seed: u8) -> Vec<u8> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(seed).wrapping_add((i >> 10) as u8))
            .collect()
    }

    /// Write `files` as attachments, taking the output after every write as the extension
    /// does, so the file is assembled from many takes rather than one finish.
    fn write_with(entries: &[SaveEntry], files: &[Vec<u8>], password: &str) -> Vec<u8> {
        let mut w = Writer::new(password).unwrap();
        let mut out = w.take();
        for f in files {
            w.begin_binary(f.len() as u64).unwrap();
            for chunk in f.chunks(64 * 1024) {
                w.write_binary(chunk).unwrap();
                out.extend(w.take());
            }
        }
        out.extend(w.finish(entries).unwrap());
        out
    }

    fn with_binaries(mut e: SaveEntry, refs: &[(&str, u32)]) -> SaveEntry {
        e.binaries = refs
            .iter()
            .map(|(n, i)| SaveBinary {
                name: (*n).into(),
                index: *i,
            })
            .collect();
        e
    }

    #[test]
    fn carries_attachments_byte_for_byte_and_names_them_on_their_entries() {
        let files = vec![body(70_000, 7), body(0, 1), body(3 * BLOCK_SIZE + 123, 13)];
        let entries = vec![
            with_binaries(
                entry(&[("Title", "Passport", false)]),
                &[("scan.pdf", 0), ("empty.txt", 1)],
            ),
            with_binaries(
                entry(&[("Title", "Deed", false)]),
                &[("deed & <copy>.bin", 2)],
            ),
        ];
        let bytes = write_with(&entries, &files, "pw");

        let (binaries, xml) = binaries_and_xml(&bytes, "pw");
        assert_eq!(binaries, files);
        // And our own reader brings them back on the entries they were written on.
        let (read, attachments) = open_full(&bytes, "pw", None).unwrap();
        let names: Vec<_> = read[0]
            .binaries
            .iter()
            .map(|b| (b.name.as_str(), b.index))
            .collect();
        assert_eq!(names, [("scan.pdf", 0), ("empty.txt", 1)]);
        let held: Vec<Vec<u8>> = attachments.iter().map(|a| a.to_vec()).collect();
        assert_eq!(held, files);
        assert!(xml.contains(r#"<Binary><Key>scan.pdf</Key><Value Ref="0"/></Binary>"#));
        assert!(xml.contains(r#"<Binary><Key>empty.txt</Key><Value Ref="1"/></Binary>"#));
        assert!(
            xml.contains(r#"<Binary><Key>deed &amp; &lt;copy&gt;.bin</Key><Value Ref="2"/></Binary>"#)
        );
        // The references are not String pairs: entries read back with exactly their own fields.
        let read = open_inner(&bytes, "pw", None).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].strings.len(), 1);
        assert_eq!(find(&read[1], "Title"), Some("Deed"));
    }

    #[test]
    fn streams_to_the_same_file_it_would_have_written_whole() {
        // Taking output between writes must not change what the file is: the same entries
        // with no attachments open identically whichever way they were written.
        let entries = vec![entry(&[("Title", "T", false), ("Password", "p", true)])];
        let streamed = write_with(&entries, &[], "pw");
        let whole = save_inner(&entries, "pw").unwrap();
        assert_eq!(
            open_inner(&streamed, "pw", None),
            open_inner(&whole, "pw", None)
        );
    }

    #[test]
    fn refuses_an_attachment_that_does_not_match_its_declared_length() {
        let mut w = Writer::new("pw").unwrap();
        w.begin_binary(4).unwrap();
        assert!(w.write_binary(b"12345").is_err(), "longer than declared");
        w.write_binary(b"123").unwrap();
        assert!(w.begin_binary(1).is_err(), "previous one unfinished");
        assert!(w.finish(&[]).is_err(), "shorter than declared");
    }

    #[test]
    fn refuses_a_reference_to_an_attachment_never_written() {
        let mut w = Writer::new("pw").unwrap();
        w.begin_binary(1).unwrap();
        w.write_binary(b"x").unwrap();
        let entries = [with_binaries(entry(&[("Title", "T", false)]), &[("a", 1)])];
        assert_eq!(
            w.finish(&entries).err(),
            Some(KdbxError::Corrupt("attachment reference out of range"))
        );
    }

    fn find<'a>(e: &'a OutEntry, key: &str) -> Option<&'a str> {
        e.strings
            .iter()
            .find(|s| s.key == key)
            .map(|s| s.value.as_str())
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
    fn round_trips_tags_through_keepass_own_tags_element() {
        // Written as <Tags>, not a <String> named "Tags", so other KeePass clients show
        // them in their tag column. The synthetic pair is just how it crosses the boundary.
        let entries = vec![entry(&[("Title", "T", false), ("Tags", "work,banking", false)])];
        let bytes = save_inner(&entries, "pw").unwrap();
        let xml = String::from_utf8_lossy(&bytes).to_string();
        assert!(!xml.contains("<Key>Tags</Key>"), "tags must not be written as a String pair");
        let read = open_inner(&bytes, "pw", None).unwrap();
        assert_eq!(find(&read[0], "Tags"), Some("work,banking"));
    }

    #[test]
    fn escapes_xml_metacharacters_in_tags() {
        let entries = vec![entry(&[("Title", "T", false), ("Tags", "a&b,<c>", false)])];
        let bytes = save_inner(&entries, "pw").unwrap();
        let read = open_inner(&bytes, "pw", None).unwrap();
        assert_eq!(find(&read[0], "Tags"), Some("a&b,<c>"));
    }

    #[test]
    fn omits_the_tags_element_when_an_entry_has_none() {
        let entries = vec![entry(&[("Title", "T", false)])];
        let bytes = save_inner(&entries, "pw").unwrap();
        let read = open_inner(&bytes, "pw", None).unwrap();
        assert_eq!(find(&read[0], "Tags"), None);
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
    /// `otp` field generates a live code, custom String fields survive, and both attachments
    /// export byte for byte.
    #[test]
    #[ignore]
    fn emit_for_keepassxc() {
        let e = |pairs: &[(&str, &str, bool)]| super::SaveEntry {
            strings: pairs.iter().map(|(k, v, p)| super::SaveString {
                key: (*k).into(), value: (*v).into(), protected: *p,
            }).collect(),
            binaries: vec![],
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
        // Two attachments on GitHub, one past an HMAC block, written to /tmp beside the file:
        //   printf 'export-pw-123\n' | keepassxc-cli attachment-export /tmp/bramble-export.kdbx \
        //     GitHub scan.bin /tmp/out.bin && cmp /tmp/out.bin /tmp/bramble-attach-scan.bin
        let files = vec![body(2 * BLOCK_SIZE + 77, 11), b"hello from bramble\n".to_vec()];
        let mut entries = entries;
        entries[0].binaries = vec![
            super::SaveBinary { name: "scan.bin".into(), index: 0 },
            super::SaveBinary { name: "note.txt".into(), index: 1 },
        ];
        std::fs::write("/tmp/bramble-attach-scan.bin", &files[0]).unwrap();
        std::fs::write("/tmp/bramble-attach-note.txt", &files[1]).unwrap();
        let bytes = write_with(&entries, &files, "export-pw-123");
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
