import CryptoKit
import Foundation

// Computes a live TOTP code from a stored key, for one-time-code AutoFill (ProvidesOneTimeCodes).
// Mirrors android/.../Totp.kt and util/totp.ts: accepts an `otpauth://totp/...` URI or a bare
// base32 secret; RFC 6238 defaults (SHA1, 6 digits, 30s). Only the digits ever leave here, never
// the seed. Returns nil for HOTP / garbage so callers can skip the entry.
enum Totp {

	static func generate(_ key: String?, now: Date = Date()) -> String? {
		guard let raw = key?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
			return nil
		}
		var secretB32 = raw
		var digits = 6
		var period = 30.0
		var algorithm = "SHA1"
		if raw.lowercased().hasPrefix("otpauth://") {
			guard raw.lowercased().hasPrefix("otpauth://totp"),  // HOTP unsupported
				let items = URLComponents(string: raw)?.queryItems,
				let secret = items.first(where: { $0.name == "secret" })?.value
			else { return nil }
			secretB32 = secret
			if let d = items.first(where: { $0.name == "digits" })?.value, let v = Int(d) { digits = v }
			if let p = items.first(where: { $0.name == "period" })?.value, let v = Double(p) { period = v }
			if let a = items.first(where: { $0.name == "algorithm" })?.value { algorithm = a.uppercased() }
		}
		// The dynamic truncation yields 31 bits, so more than 10 digits is meaningless.
		guard period > 0, (1...10).contains(digits), let secret = base32Decode(secretB32) else {
			return nil
		}
		let counter = UInt64(max(0, (now.timeIntervalSince1970 / period).rounded(.down)))
		return hotp(secret: secret, counter: counter, digits: digits, algorithm: algorithm)
	}

	private static func hotp(secret: Data, counter: UInt64, digits: Int, algorithm: String) -> String?
	{
		var be = counter.bigEndian
		let msg = withUnsafeBytes(of: &be) { Data($0) }
		let key = SymmetricKey(data: secret)
		let mac: Data
		switch algorithm {
		case "SHA256": mac = Data(HMAC<SHA256>.authenticationCode(for: msg, using: key))
		case "SHA512": mac = Data(HMAC<SHA512>.authenticationCode(for: msg, using: key))
		default: mac = Data(HMAC<Insecure.SHA1>.authenticationCode(for: msg, using: key))
		}
		guard let last = mac.last else { return nil }
		let offset = Int(last & 0x0f)
		guard mac.count >= offset + 4 else { return nil }
		let binary =
			(UInt32(mac[offset] & 0x7f) << 24) | (UInt32(mac[offset + 1]) << 16)
			| (UInt32(mac[offset + 2]) << 8) | UInt32(mac[offset + 3])
		let mod = UInt32(pow(10.0, Double(digits)))
		return String(format: "%0\(digits)u", binary % mod)
	}

	private static func base32Decode(_ input: String) -> Data? {
		var clean = input
			.replacingOccurrences(of: "[\\s-]", with: "", options: .regularExpression)
			.uppercased()
		while clean.hasSuffix("=") { clean.removeLast() }
		if clean.isEmpty { return nil }
		let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
		var buffer = 0
		var bitsLeft = 0
		var out = Data()
		for ch in clean {
			guard let v = alphabet.firstIndex(of: ch) else { return nil }
			buffer = (buffer << 5) | v
			bitsLeft += 5
			if bitsLeft >= 8 {
				bitsLeft -= 8
				out.append(UInt8((buffer >> bitsLeft) & 0xff))
			}
		}
		return out.isEmpty ? nil : out
	}
}
