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

        # CI shell is used in GitHub Actions
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

        # Local dev shell is the CI shell, plus some extra tools
        devShells.default = pkgs.mkShell {
          inputsFrom = [ ciShell ];
          nativeBuildInputs = with pkgs; [
            nodePackages.typescript-language-server
            nodePackages.vscode-json-languageserver
            nodePackages.yaml-language-server
            protobuf_29
          ];
        };

        # The CI image is created as a cached env for CI to run in
        packages.ciImage = pkgs.dockerTools.buildImage {
          name = "inngest-ci";
          tag = "latest";
          # put the whole CI shell into the image
          contents = [ ciShell ];
          config = {
            Cmd = [ "bash" ];
          };
        };
      }
    );
}
