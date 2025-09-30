{
  description = "Inngest JS/TS SDK";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix2container.url = "github:nlewo/nix2container";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      nix2container,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        n2c = nix2container.packages.${system};

        # Corepack wrapper (links to system node)
        corepack = pkgs.stdenv.mkDerivation {
          name = "corepack";
          buildInputs = [ pkgs.nodejs_24 ];
          phases = [ "installPhase" ];
          installPhase = ''
            mkdir -p $out/bin
            corepack enable --install-directory=$out/bin
          '';
        };

        # CI packages
        ciPkgs = [
          corepack
          pkgs.nodejs_24
          pkgs.bun
        ];

        ciShell = pkgs.mkShell {
          packages = ciPkgs;
          shellHook = ''
            export COREPACK_ENABLE_AUTO_PIN=0
          '';
        };

        devShell = pkgs.mkShell {
          inputsFrom = [ ciShell ];
          nativeBuildInputs = with pkgs; [
            nodePackages.typescript-language-server
            nodePackages.vscode-json-languageserver
            nodePackages.yaml-language-server
            protobuf_29
          ];
        };

        ciEnv = pkgs.buildEnv {
          name = "ci-env";
          paths = ciPkgs;
        };
      in
      {
        devShells.ci = ciShell;
        devShells.default = devShell;

        packages.ci = ciEnv;

        packages.ci-image = n2c.nix2container.buildImage {
          name = "ci";
          tag = "latest";

          # only link /bin from deps into /
          copyToRoot = pkgs.buildEnv {
            name = "root";
            paths = ciPkgs;
            pathsToLink = [ "/bin" ];
          };

          config = {
            Env = [
              "PATH=/bin"
              "COREPACK_ENABLE_AUTO_PIN=0"
            ];
            WorkingDir = "/workspace";
            Cmd = [ "bash" ];
          };

          # prune: if anything non-bin sneaks in, strip it
          perms = [
            {
              path = "${pkgs.nodejs_24}";
              regex = ".*share.*";
              mode = "0000";
            }
            {
              path = "${pkgs.nodejs_24}";
              regex = ".*include.*";
              mode = "0000";
            }
            {
              path = "${pkgs.bun}";
              regex = ".*share.*";
              mode = "0000";
            }
            {
              path = "${pkgs.bun}";
              regex = ".*include.*";
              mode = "0000";
            }
          ];
        };
      }
    );
}
