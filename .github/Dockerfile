FROM nixos/nix:latest

WORKDIR /ci-src
COPY . .

# Build the ci package into /nix/ci
RUN nix --extra-experimental-features 'nix-command flakes' \
        build .#ci -o /nix/ci

ENV PATH="/nix/ci/bin:$PATH"

RUN pnpm install --frozen-lockfile

WORKDIR /workspace
CMD ["bash"]
