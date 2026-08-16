# A Nix package for the desktop app, so NixOS users can install Bramble without waiting on
# nixpkgs.
#
# Deliberately a flake in this repository rather than a nixpkgs submission, at least first:
# nixpkgs is not a channel you publish to, it is one you submit to, and a fix would then reach
# people when a committer merges and Hydra builds rather than when it is released. This gets the
# same package to the same users on our own schedule, and CI can build it so it cannot rot.
# Upstreaming later is a strict addition. See docs/desktop-port.md.
#
#   nix build github:flythenimbus/bramble
#   nix run   github:flythenimbus/bramble
#
# Or in a system configuration, via the overlay this exposes.

{
  description = "Bramble: an offline-first password manager with direct device-to-device sync";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      # Linux only: the desktop app is a Tauri/webkit2gtk binary, and the macOS build is signed
      # and notarised through a completely different pipeline (docs/release-signing.md).
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (pkgs: rec {
        bramble = pkgs.callPackage ./packages/platform-desktop/nix/package.nix {
          # `self` rather than a relative path, so the build sees the flake's own source and a
          # dirty tree is caught rather than silently built from the checkout.
          src = self;
        };
        default = bramble;
      });

      overlays.default = final: _prev: {
        bramble = final.callPackage ./packages/platform-desktop/nix/package.nix { src = self; };
      };

      # `nix flake check` builds the package, which is the only check worth having here: the
      # failure this guards against is the derivation drifting away from the repository.
      checks = forEachSystem (pkgs: { bramble = self.packages.${pkgs.system}.bramble; });
    };
}
