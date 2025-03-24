# Inngest Realtime demos

This [Next.js](https://nextjs.org) project demonstrates examples of [Inngest Realtime](https://www.inngest.com/docs/features/realtime).

## Examples

1. **Hello World Stream** (`/hello-world`): A simple example demonstrating basic streaming functionality with a button that triggers a stream of "Hello World" updates.

2. **Agent Kit Search** (`/agent-kit`): An interactive search interface that showcases real-time streaming responses as you type, similar to an AI agent interaction.

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd examples/realtime-demos
```

2. Install dependencies:

```bash
npm install
# or
yarn install
# or
pnpm install
# or
bun install
```

3. Set up your environment variables:

```bash
cp .env.example .env.local
```

Then edit `.env.local` with your configuration values.

## Getting Started

Run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the examples by modifying:

- `app/hello-world/page.tsx` for the Hello World example
- `app/agent-kit/page.tsx` for the Agent Kit example

The pages auto-update as you edit the files.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.
