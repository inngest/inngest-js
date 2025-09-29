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
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Node
            nodejs_24
            pnpm
            typescript

            # bun
            bun

            # LSPs
            nodePackages.typescript-language-server
            nodePackages.vscode-json-languageserver
            nodePackages.yaml-language-server

            # Tools
            protobuf_29
          ];

          shellHook = ''
            export COREPACK_ENABLE_AUTO_PIN=0
            corepack prepare --activate --prefer-offline
          '';
        };
      }
    );
}
