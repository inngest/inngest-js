# Next.js Starter with shadcn, inngest, and @inngest/realtime

This project is a Next.js starter configured with:

- [shadcn/ui](https://ui.shadcn.com/)
- [inngest](https://www.inngest.com/)
- [@inngest/realtime](https://www.inngest.com/docs/features/realtime)
- [Tailwind CSS](https://tailwindcss.com/)

## Tailwind CSS Setup

Tailwind is manually configured. Key files:

- `tailwind.config.js`
- `postcss.config.js`
- `src/app/globals.css` (with Tailwind directives)

## Getting Started

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```
3. Visit [http://localhost:3000](http://localhost:3000)

## Next Steps

- Run `npx shadcn@latest init` to finish shadcn/ui setup.
- Add your inngest and @inngest/realtime configuration and usage as needed.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Inngest Setup

- The Inngest client is configured in `src/lib/inngest.ts`.
- The API route for Inngest is at `src/app/api/inngest/route.ts`.
- To add functions, create them and add to the `functions` array in the serve handler.
- To run the Inngest Dev Server locally:
  ```bash
  npx inngest-cli@latest dev -u http://localhost:3000/api/inngest
  ```
  Then visit [http://localhost:8288](http://localhost:8288) for the Inngest UI.
