import CryptoKit
import Foundation

// Computes a live TOTP code from a stored key, for one-time-code AutoFill (ProvidesOneTimeCodes).
// Mirrors android/.../Totp.kt and util/totp.ts: accepts an `otpauth://totp/...` URI, a Steam Guard
// key (`steam://`, `otpauth://steam/` or `encoder=steam`) or a bare base32 secret; RFC 6238
// defaults (SHA1, 6 digits, 30s). Only the code ever leaves here, never the seed. Returns nil for
// HOTP / garbage so callers can skip the entry.
enum Totp {

	private static let steamAlphabet = Array("23456789BCDFGHJKMNPQRTVWXY")

	static func generate(_ key: String?, now: Date = Date()) -> String? {
		guard let raw = key?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
			return nil
		}
		var secretB32 = raw
		var digits = 6
		var period = 30.0
		var algorithm = "SHA1"
		var steam = false
		let lower = raw.lowercased()
		if lower.hasPrefix("steam://") {
			secretB32 = String(raw.dropFirst("steam://".count))
			steam = true
		} else if lower.hasPrefix("otpauth://") {
			guard let parts = URLComponents(string: raw), let items = parts.queryItems,
				let secret = items.first(where: { $0.name.lowercased() == "secret" })?.value
			else { return nil }
			let host = parts.host?.lowercased()
			steam =
				host == "steam"
				|| items.first(where: { $0.name.lowercased() == "encoder" })?.value?.lowercased() == "steam"
			guard host == "totp" || steam else { return nil }  // HOTP unsupported
			secretB32 = secret
			if let d = items.first(where: { $0.name == "digits" })?.value, let v = Int(d) { digits = v }
			if let p = items.first(where: { $0.name == "period" })?.value, let v = Double(p) { period = v }
			if let a = items.first(where: { $0.name == "algorithm" })?.value {
				algorithm = a.uppercased().replacingOccurrences(of: "-", with: "")
			}
		}
		guard let secret = base32Decode(secretB32) else { return nil }
		if steam {
			let counter = UInt64(max(0, (now.timeIntervalSince1970 / 30).rounded(.down)))
			guard var n = truncate(secret: secret, counter: counter, algorithm: "SHA1") else { return nil }
			var code = ""
			for _ in 0..<5 {
				code.append(steamAlphabet[Int(n % UInt32(steamAlphabet.count))])
				n /= UInt32(steamAlphabet.count)
			}
			return code
		}
		// The dynamic truncation yields 31 bits, so more than 10 digits is meaningless.
		guard period > 0, (1...10).contains(digits) else { return nil }
		let counter = UInt64(max(0, (now.timeIntervalSince1970 / period).rounded(.down)))
		guard let binary = truncate(secret: secret, counter: counter, algorithm: algorithm) else {
			return nil
		}
		let mod = UInt64(pow(10.0, Double(digits)))
		return String(format: "%0\(digits)llu", UInt64(binary) % mod)
	}

	// RFC 4226 dynamic truncation: the 31-bit value a code is cut from.
	private static func truncate(secret: Data, counter: UInt64, algorithm: String) -> UInt32? {
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
		return (UInt32(mac[offset] & 0x7f) << 24) | (UInt32(mac[offset + 1]) << 16)
			| (UInt32(mac[offset + 2]) << 8) | UInt32(mac[offset + 3])
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
