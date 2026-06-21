#!/usr/bin/env ruby
# Adds the AutoFillProbe app-extension target to the committed iOS project, surgically,
# via the xcodeproj gem (leaves the Capacitor CapApp-SPM refs, BiometricVault, and the
# storyboard subclass untouched). Idempotent: aborts if the target already exists.
#
#   gem install --user-install xcodeproj
#   ruby scripts/add-autofill-probe.rb
#
# This is the Phase 3 autofill go/no-go probe. See docs/mobile-port.md.

require "xcodeproj"

PROJECT = File.expand_path("../ios/App/App.xcodeproj", __dir__)
EXT_NAME = "AutoFillProbe"
APP_GROUP = "group.app.bramble.mobile"
BUNDLE_ID = "app.bramble.mobile.AutoFillProbe"

project = Xcodeproj::Project.open(PROJECT)
app = project.targets.find { |t| t.name == "App" } or abort("App target not found")
abort("#{EXT_NAME} target already exists; nothing to do") if project.targets.any? { |t| t.name == EXT_NAME }

# 1. The extension target (app_extension product type) + its build settings.
ext = project.new_target(:app_extension, EXT_NAME, :ios, "15.0")
# new_target auto-links Foundation.framework via an SDK-version-pinned path that won't
# resolve under a newer Xcode; Swift auto-links it, so drop the stray reference.
ext.frameworks_build_phase.files.dup.each { |bf| ext.frameworks_build_phase.remove_build_file(bf) }
project.main_group.recursive_children
  .select { |c| c.is_a?(Xcodeproj::Project::Object::PBXFileReference) && c.display_name == "Foundation.framework" }
  .each(&:remove_from_project)
ext.build_configurations.each do |c|
  bs = c.build_settings
  bs["PRODUCT_BUNDLE_IDENTIFIER"] = BUNDLE_ID
  bs["PRODUCT_NAME"] = "$(TARGET_NAME)"
  bs["INFOPLIST_FILE"] = "#{EXT_NAME}/Info.plist"
  bs["CODE_SIGN_ENTITLEMENTS"] = "#{EXT_NAME}/#{EXT_NAME}.entitlements"
  bs["CODE_SIGN_STYLE"] = "Automatic"
  bs["IPHONEOS_DEPLOYMENT_TARGET"] = "15.0"
  bs["SWIFT_VERSION"] = "5.0"
  bs["GENERATE_INFOPLIST_FILE"] = "NO"
  bs["SKIP_INSTALL"] = "YES"
  bs["TARGETED_DEVICE_FAMILY"] = "1,2"
  bs["ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES"] = "NO"
  bs["LD_RUNPATH_SEARCH_PATHS"] =
    ["$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks"]
  bs["SWIFT_OPTIMIZATION_LEVEL"] = c.name == "Debug" ? "-Onone" : "-O"
end

# 2. Source group + files (the .swift compiles; Info.plist/entitlements are referenced for tidiness).
group = project.main_group.new_group(EXT_NAME, EXT_NAME)
vc = group.new_reference("CredentialProviderViewController.swift")
ext.add_file_references([vc])
group.new_reference("Info.plist")
group.new_reference("#{EXT_NAME}.entitlements")

# 3. Embed the built .appex into the app, and build the extension before the app.
embed = app.new_copy_files_build_phase("Embed App Extensions")
embed.symbol_dst_subfolder_spec = :plug_ins
bf = embed.add_file_reference(ext.product_reference)
bf.settings = { "ATTRIBUTES" => ["RemoveHeadersOnCopy"] }
app.add_dependency(ext)

# 4. App target gets the App Group entitlement so it can write to the shared container.
app.build_configurations.each { |c| c.build_settings["CODE_SIGN_ENTITLEMENTS"] = "App/App.entitlements" }
app_group_node = project.main_group.children.find { |c| c.isa == "PBXGroup" && c.display_name == "App" }
app_group_node&.new_reference("App.entitlements")

project.save

puts "Added target #{EXT_NAME} (#{BUNDLE_ID}), App Group #{APP_GROUP}."
puts "Targets now: #{project.targets.map(&:name).join(", ")}"
puts "App embed phases: #{app.build_phases.map { |p| p.display_name }.join(", ")}"
