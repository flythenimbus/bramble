import Foundation

// The extension -> app handoffs (minted passkeys, fill-and-save associations): a JSON array of
// VEK-encrypted {iv, ciphertext} records per queue, in a file in the App Group container. The
// extension appends and the app drains, each under an exclusive flock on the shared container, so
// an append racing a drain is never lost. A file rather than UserDefaults: each process caches its
// defaults, so even a locked read there can be stale. Compiled into the App AND AutoFillProbe.
enum AppGroupHandoff {
	typealias Record = [String: String]

	enum Queue: String {
		case passkeys = "pending-passkeys.json"
		case associations = "pending-associations.json"

		// Where builds before the file queue kept it; drained once, with the file.
		var legacyKey: String {
			switch self {
			case .passkeys: return BrambleVault.pendingPasskeysKey
			case .associations: return BrambleVault.pendingAssociationsKey
			}
		}
	}

	static func append(_ record: Record, to queue: Queue) {
		update(queue) { $0 + [record] }
	}

	/// Every pending record, cleared in the same locked step.
	static func take(_ queue: Queue) -> [Record] {
		var taken: [Record] = []
		update(queue) { current in
			let defaults = UserDefaults(suiteName: BrambleVault.appGroup)
			let legacy = (defaults?.array(forKey: queue.legacyKey) as? [Record]) ?? []
			defaults?.removeObject(forKey: queue.legacyKey)
			taken = legacy + current
			return []
		}
		return taken
	}

	/// Put back records the app couldn't decrypt (another vault's), ahead of any appended since.
	static func restore(_ keep: [Record], to queue: Queue) {
		guard !keep.isEmpty else { return }
		update(queue) { keep + $0 }
	}

	static func removeAll() {
		for queue in [Queue.passkeys, .associations] {
			update(queue) { _ in [] }
			UserDefaults(suiteName: BrambleVault.appGroup)?.removeObject(forKey: queue.legacyKey)
		}
	}

	/// Run `body` holding the App Group lock, for other read-modify-writes of shared state.
	static func locked<T>(_ body: () -> T) -> T {
		let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: BrambleVault.appGroup)
		let fd = dir.map { open($0.appendingPathComponent("handoff.lock").path, O_CREAT | O_RDWR, 0o600) } ?? -1
		// Unlocked rather than not at all: dropping a minted passkey is worse than a rare race.
		if fd >= 0 { flock(fd, LOCK_EX) }
		defer { if fd >= 0 { close(fd) } }  // closing releases the lock
		return body()
	}

	private static func update(_ queue: Queue, _ change: ([Record]) -> [Record]) {
		guard
			let url = FileManager.default.containerURL(
				forSecurityApplicationGroupIdentifier: BrambleVault.appGroup)?
				.appendingPathComponent(queue.rawValue)
		else { return }
		locked {
			let current =
				(try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [Record] }
				?? []
			let next = change(current)
			if next.isEmpty {
				try? FileManager.default.removeItem(at: url)
			} else if let data = try? JSONSerialization.data(withJSONObject: next) {
				try? data.write(to: url, options: .atomic)
			}
		}
	}
}
