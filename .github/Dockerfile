FROM debian:bookworm-slim AS build

# install nix
RUN apt-get update && apt-get install -y --no-install-recommends curl xz-utils ca-certificates sudo && rm -rf /var/lib/apt/lists/*
RUN useradd -m nix && echo "nix ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER nix
WORKDIR /home/nix
RUN curl -L https://nixos.org/nix/install | sh -s -- --no-daemon
ENV PATH="/home/nix/.nix-profile/bin:$PATH"

WORKDIR /ci-src
COPY flake.nix flake.lock ./

# build ci package
RUN nix --extra-experimental-features 'nix-command flakes' build .#ci -o /nix/ci

RUN nix --extra-experimental-features 'nix-command flakes' \
    path-info --recursive $(readlink -f /nix/ci) \
  | xargs tar -C / -cf /tmp/closure.tar

# -------- final --------
FROM debian:bookworm-slim

# Need ca-certificates for resolving pnpm deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      unzip \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /tmp/closure.tar /tmp/closure.tar
RUN tar -C / -xf /tmp/closure.tar
COPY --from=build /nix/ci /nix/ci
ENV PATH="/nix/ci/bin:$PATH"
WORKDIR /workspace
CMD ["bash"]

