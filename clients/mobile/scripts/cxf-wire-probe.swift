// CXF wire probe, both directions.
//
//   spike                -> build a payload the way our exporter would and print the JSON,
//                           for diffing against the CXF spec.
//   spike <file.json>    -> decode a payload WE produced through Apple's own decoder, which
//                           is the only way to find out what iOS will reject before a device
//                           says "contains unsupported data" and names nothing.
//
// Build + run (see docs/credential-exchange.md):
//   xcrun swiftc -sdk $(xcrun --sdk iphonesimulator --show-sdk-path) \
//     -target arm64-apple-ios26.0-simulator scripts/cxf-wire-probe.swift -o /tmp/cxf-probe
//   xcrun simctl spawn booted /tmp/cxf-probe /tmp/payload.json

import AuthenticationServices
import Foundation

// Same coders as CredentialExchange.swift: CXF dates are UNIX seconds, the default counts from 2001.
func cxfDecoder() -> JSONDecoder {
	let decoder = JSONDecoder()
	decoder.dateDecodingStrategy = .secondsSince1970
	return decoder
}

/// Whether a passkey's PRF secrets survived Apple's decoder; the field only exists from 26.4.
func prfCarried(_ p: ASImportableCredential.Passkey) -> String {
	if #available(iOS 26.4, macOS 26.4, *) {
		return p.fido2Extensions?.hmacCredentials != nil ? "yes" : "no"
	}
	return "unsupported"
}

/// Decode one of our payloads and report what Apple's types actually accepted.
func inspect(path: String) -> Never {
	guard let data = FileManager.default.contents(atPath: path) else {
		print("=== FAILED: can't read \(path) ===")
		exit(1)
	}
	do {
		let payload = try cxfDecoder().decode(ASExportedCredentialData.self, from: data)
		print("=== DECODED: \(payload.accounts.count) account(s) ===")
		for account in payload.accounts {
			for item in account.items {
				let kinds = item.credentials.map { credential -> String in
					switch credential {
					case .basicAuthentication: return "basic-auth"
					case .passkey(let p): return "passkey(prf=\(prfCarried(p)))"
					case .totp: return "totp"
					case .note: return "note"
					case .creditCard: return "credit-card"
					case .sshKey: return "ssh-key"
					case .customFields: return "custom-fields"
					default: return "other"
					}
				}
				print("  item title=\(item.title.isEmpty ? "<EMPTY>" : item.title) " +
					"scope=\(item.scope?.urls.map(\.absoluteString) ?? []) credentials=\(kinds) " +
					"created=\(item.created.map { "\($0)" } ?? "nil")")
			}
		}
		exit(0)
	} catch {
		// The whole payload fails as a unit, so this is what a device would be reacting to.
		print("=== REJECTED ===")
		print(error)
		exit(1)
	}
}

if CommandLine.arguments.count > 1 { inspect(path: CommandLine.arguments[1]) }

func field(_ v: String, _ t: ASImportableEditableField.FieldType = .string) -> ASImportableEditableField {
	ASImportableEditableField(id: nil, fieldType: t, value: v)
}

let basicAuth = ASImportableCredential.basicAuthentication(
	.init(userName: field("ada@example.com", .email), password: field("hunter2", .concealedString)))

let totp = ASImportableCredential.totp(
	.init(
		secret: Data("JBSWY3DPEHPK3PXP".utf8), period: 30, digits: 6, userName: "ada@example.com",
		algorithm: .sha1, issuer: "GitHub"))

// Mirrors PasskeyCredential in core/src/hooks/useVault.tsx.
var passkeyRecord = ASImportableCredential.Passkey(
	credentialID: Data([0x01, 0x02, 0x03, 0x04]),
	relyingPartyIdentifier: "github.com",
	userName: "ada",
	userDisplayName: "Ada Lovelace",
	userHandle: Data([0xAA, 0xBB]),
	key: Data([0x30, 0x81, 0x87, 0x02, 0x01, 0x00])) // PKCS#8 prefix, truncated
// PRF secrets and a large blob, which Apple's types carry from 26.4 (docs/passkey-prf.md).
if #available(iOS 26.4, macOS 26.4, *) {
	passkeyRecord.fido2Extensions = ASImportableFIDO2Extensions(
		hmacCredentials: ASImportableFIDO2HMACCredential(
			algorithm: .sha256, credentialWithUV: Data(repeating: 0xAA, count: 32),
			credentialWithoutUV: Data(repeating: 0xBB, count: 32)),
		largeBlob: ASImportableFIDO2LargeBlob(uncompressedSize: 3, data: Data([1, 2, 3])))
}
let passkey = ASImportableCredential.passkey(passkeyRecord)

let note = ASImportableCredential.note(.init(content: field("recovery kit in the safe")))

let item = ASImportableItem(
	id: Data("item-0001".utf8),
	created: Date(timeIntervalSince1970: 1_700_000_000),
	lastModified: Date(timeIntervalSince1970: 1_750_000_000),
	title: "GitHub",
	subtitle: nil,
	favorite: true,
	scope: ASImportableCredentialScope(urls: [URL(string: "https://github.com")!]),
	credentials: [basicAuth, totp, passkey, note],
	tags: ["work"])

let account = ASImportableAccount(
	id: Data("acct-0001".utf8), userName: "ada", email: "ada@example.com", fullName: "Ada Lovelace",
	collections: [], items: [item])

let payload = ASExportedCredentialData(
	accounts: [account], formatVersion: .v1, exporterRelyingPartyIdentifier: "app.bramble.mobile",
	exporterDisplayName: "Bramble", timestamp: Date(timeIntervalSince1970: 1_760_000_000))

let enc = JSONEncoder()
enc.dateEncodingStrategy = .secondsSince1970
enc.outputFormatting = [.prettyPrinted, .sortedKeys]

do {
	let json = try enc.encode(payload)
	print("=== ENCODED ===")
	print(String(data: json, encoding: .utf8)!)

	let back = try cxfDecoder().decode(ASExportedCredentialData.self, from: json)
	print("=== ROUND TRIP: \(back == payload ? "IDENTICAL" : "DIFFERS") ===")
} catch {
	print("=== FAILED: \(error) ===")
}
