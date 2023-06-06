{ pkgs ? import (fetchTarball
  "https://github.com/NixOS/nixpkgs/archive/refs/tags/23.05.tar.gz") { } }:

with pkgs;

mkShell {
  buildInputs = [
    # Node
    pkgs.yarn
    pkgs.nodejs-18_x

    # LSPs
    pkgs.nodePackages.typescript-language-server
    pkgs.nodePackages.vscode-json-languageserver
    pkgs.nodePackages.yaml-language-server

    # Tools
  ];
}
