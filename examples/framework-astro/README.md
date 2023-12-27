# Inngest Astro Template

This is an [Astro](https://astro.build/) project bootstrapped with [`create astro`](https://docs.astro.build/en/install/auto/). It is a reference on how to send and receive events with Inngest and Astro.

## Getting Started

Use [`create astro`](https://docs.astro.build/en/install/auto/) with [npm](https://docs.npmjs.com/cli/init), [Yarn](https://yarnpkg.com/lang/en/docs/cli/create/), or [pnpm](https://pnpm.io) to bootstrap the example:

```bash
npm create astro@latest --template https://github.com/inngest/inngest-js/tree/main/examples/framework-astro inngest-astro
```

```bash
yarn create astro@latest --template https://github.com/inngest/inngest-js/tree/main/examples/framework-astro inngest-astro
```

```bash
pnpm create astro@latest --template https://github.com/inngest/inngest-js/tree/main/examples/framework-astro inngest-astro
```

Open [http://localhost:3000](http://localhost:3000/api/inngest) with your browser to see the result.

- [Inngest functions](https://www.inngest.com/docs/functions) are available at `src/inngest/`.
- The [Inngest handler](https://www.inngest.com/docs/sdk/serve) is available a `src/pages/api/inngest.ts`.

## Learn More

- [Inngest Documentation](https://www.inngest.com/docs) - learn about the Inngest SDK, functions, and events
- [Astro Documentation](https://docs.astro.build/en/getting-started/) - learn about Astro features and API.

# Astro Starter Kit: Basics

```sh
npm create astro@latest -- --template basics
```

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/withastro/astro/tree/latest/examples/basics)
[![Open with CodeSandbox](https://assets.codesandbox.io/github/button-edit-lime.svg)](https://codesandbox.io/p/sandbox/github/withastro/astro/tree/latest/examples/basics)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/withastro/astro?devcontainer_path=.devcontainer/basics/devcontainer.json)

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

![just-the-basics](https://github.com/withastro/astro/assets/2244813/a0a5533c-a856-4198-8470-2d67b1d7c554)

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
│   └── favicon.svg
├── src/
│   ├── components/
│   │   └── Card.astro
│   ├── layouts/
│   │   └── Layout.astro
│   └── pages/
│       └── index.astro
└── package.json
```

Astro looks for `.astro` or `.md` files in the `src/pages/` directory. Each page is exposed as a route based on its file name.

There's nothing special about `src/components/`, but that's where we like to put any Astro/React/Vue/Svelte/Preact components.

Any static assets, like images, can be placed in the `public/` directory.

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).
