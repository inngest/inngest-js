FROM nixos/nix:latest

WORKDIR /ci-src
COPY . .

# Materialize default devShell into a profile
RUN nix --extra-experimental-features 'nix-command flakes' develop . --profile /nix/ci-profile

ENV PATH="/nix/ci-profile/bin:$PATH"

# Install dependencies inside the image
RUN pnpm install --frozen-lockfile

WORKDIR /workspace
CMD ["bash"]
