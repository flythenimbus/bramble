// Phase 0 spike: is ASExportedCredentialData's Codable wire format CXF-conformant JSON?
// Build a payload the way our exporter would, encode it, and print the JSON for diffing
// against fidoalliance.org/specs/cx/cxf-v1.0-ps-20250814.html. Then round-trip it.

import AuthenticationServices
import Foundation

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
let passkey = ASImportableCredential.passkey(
	.init(
		credentialID: Data([0x01, 0x02, 0x03, 0x04]),
		relyingPartyIdentifier: "github.com",
		userName: "ada",
		userDisplayName: "Ada Lovelace",
		userHandle: Data([0xAA, 0xBB]),
		key: Data([0x30, 0x81, 0x87, 0x02, 0x01, 0x00]))) // PKCS#8 prefix, truncated

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
enc.outputFormatting = [.prettyPrinted, .sortedKeys]

do {
	let json = try enc.encode(payload)
	print("=== ENCODED ===")
	print(String(data: json, encoding: .utf8)!)

	let back = try JSONDecoder().decode(ASExportedCredentialData.self, from: json)
	print("=== ROUND TRIP: \(back == payload ? "IDENTICAL" : "DIFFERS") ===")
} catch {
	print("=== FAILED: \(error) ===")
}
