FROM nixos/nix:latest as build

# Copy in just the files that determine the dependency hash
WORKDIR /src
COPY flake.nix flake.lock pnpm-lock.yaml ./

# Build a derivation that includes the CI devShell + node_modules
RUN nix --extra-experimental-features 'nix-command flakes' build .#ciImage -o /image

# Final runtime image
FROM debian:bookworm-slim
COPY --from=build /image/ /
WORKDIR /workspace
CMD ["bash"]
