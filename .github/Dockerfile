FROM debian:bookworm-slim AS base

# minimal deps to install nix
RUN apt-get update && \
    apt-get install -y curl xz-utils ca-certificates sudo && \
    rm -rf /var/lib/apt/lists/*

# create a non-root user for nix
RUN useradd -m nix && echo "nix ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER nix
ENV USER=nix
WORKDIR /home/nix

# install nix
RUN curl -L https://nixos.org/nix/install | sh -s -- --no-daemon

ENV PATH="/home/nix/.nix-profile/bin:$PATH"

WORKDIR /ci-src
COPY flake.nix flake.lock ./

RUN nix --extra-experimental-features 'nix-command flakes' \
    build .#ci -o /nix/ci

# final image
FROM debian:bookworm-slim
COPY --from=base /nix/ci /nix/ci
ENV PATH="/nix/ci/bin:$PATH"
WORKDIR /workspace
CMD ["bash"]
