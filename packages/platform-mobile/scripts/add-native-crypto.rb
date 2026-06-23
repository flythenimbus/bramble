#!/usr/bin/env ruby
# Wires the shared Rust crypto core into the committed iOS project, surgically, via
# the xcodeproj gem (leaves Capacitor's CapApp-SPM refs and the storyboard subclass
# untouched). Fully idempotent: each item is added only if missing, so it is safe to
# re-run after `pnpm ffi:build:ios` regenerates VaultCryptoFFI/.
#
#   gem install --user-install xcodeproj
#   pnpm ffi:build:ios
#   ruby scripts/add-native-crypto.rb
#
# App target: VaultCrypto.xcframework (static, link-only) + the uniffi Swift glue
# + NativeCrypto.swift (the Capacitor crypto plugin) + AutofillBridge.swift (writes
# the App Group secrets + identity store). AutoFillProbe (the credential provider):
# the same xcframework + glue, so it decrypts natively. docs/mobile-port.md.

require "xcodeproj"

PROJECT = File.expand_path("../ios/App/App.xcodeproj", __dir__)
FFI_DIR = "VaultCryptoFFI"

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == "App" } or abort("App target not found")
ext = project.targets.find { |t| t.name == "AutoFillProbe" }

app_group = project.main_group.children.find { |c| c.isa == "PBXGroup" && c.display_name == "App" }
abort("App source group not found") unless app_group
ffi_group = project.main_group.children.find { |c| c.isa == "PBXGroup" && c.display_name == FFI_DIR } ||
  project.main_group.new_group(FFI_DIR, FFI_DIR)

def has_source?(target, name)
  target.source_build_phase.files_references.any? { |r| r&.display_name == name }
end

def has_framework?(target, name)
  target.frameworks_build_phase.files_references.any? { |r| r&.display_name == name }
end

# A single file reference per path, reused across targets.
def ref_in(group, path)
  group.files.find { |f| f.display_name == path } || group.new_reference(path)
end

glue = ref_in(ffi_group, "vault_crypto.swift")
xcf = ref_in(ffi_group, "VaultCrypto.xcframework")
xcf.last_known_file_type = "wrapper.xcframework"

# App-only plugin sources (sit beside BiometricVault.swift).
["NativeCrypto.swift", "AutofillBridge.swift"].each do |name|
  next if has_source?(app, name)
  app.add_file_references([ref_in(app_group, name)])
end

# Glue + xcframework: the App and the credential-provider extension both decrypt.
[app, ext].compact.each do |target|
  target.add_file_references([glue]) unless has_source?(target, "vault_crypto.swift")
  target.frameworks_build_phase.add_file_reference(xcf) unless has_framework?(target, "VaultCrypto.xcframework")
  target.build_configurations.each do |c|
    paths = Array(c.build_settings["FRAMEWORK_SEARCH_PATHS"] || ["$(inherited)"])
    entry = "$(PROJECT_DIR)/#{FFI_DIR}"
    unless paths.include?(entry)
      paths << entry
      c.build_settings["FRAMEWORK_SEARCH_PATHS"] = paths
    end
  end
end

project.save

puts "Wired VaultCryptoFFI into: #{[app, ext].compact.map(&:name).join(", ")}"
puts "App sources: NativeCrypto.swift, AutofillBridge.swift, vault_crypto.swift"
puts "App frameworks: #{app.frameworks_build_phase.files.map { |f| f.display_name }.join(", ")}"
puts "Ext frameworks: #{ext&.frameworks_build_phase&.files&.map { |f| f.display_name }&.join(", ")}" if ext
