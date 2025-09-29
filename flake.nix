{
  description = "Inngest JS/TS SDK";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };

        corepack = pkgs.stdenv.mkDerivation {
          name = "corepack";
          buildInputs = [ pkgs.nodejs_24 ];
          phases = [ "installPhase" ];
          installPhase = ''
            mkdir -p $out/bin
            corepack enable --install-directory=$out/bin
          '';
        };

        # Shell used in CI
        ciShell = pkgs.mkShell {
          packages = [
            corepack
            pkgs.nodejs_24
            pkgs.typescript
            pkgs.bun
          ];
          nativeBuildInputs = [ pkgs.pnpm ];
          shellHook = ''
            export COREPACK_ENABLE_AUTO_PIN=0
          '';
        };
      in
      {
        devShells.ci = ciShell;

        # Local dev shell, which is the CI shell plus extras exclusive to local
        # dev
        devShells.default = pkgs.mkShell {
          inputsFrom = [ ciShell ];
          nativeBuildInputs = with pkgs; [
            nodePackages.typescript-language-server
            nodePackages.vscode-json-languageserver
            nodePackages.yaml-language-server
            protobuf_29
          ];
        };
      }
    );
}
