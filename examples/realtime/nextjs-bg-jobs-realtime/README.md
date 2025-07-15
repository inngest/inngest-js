# CampaignCraft - How to add background jobs with real-time updates to an Next.js application

## Prerequisites

- Node.js (18+ recommended)
- A Neon Postgres instance (https://neon.tech/)
- An OpenAI API key (for AI features)

For deployment only:

- A Resend API key (for email sending)
- An Inngest account
- A Vercel account

## Getting Started

1. **Copy environment variables:**

   ```bash
   cp .env.example .env
   # Edit .env to add your Neon, OpenAI, and Resend credentials
   ```

2. **Create a Neon Postgres instance:**
   - Go to [neon.tech](https://neon.tech/) and create a new project.
   - Copy the connection string and set it as `DATABASE_URL` in your `.env` file.

3. **Install dependencies:**

   ```bash
   npm install
   ```

4. **Run database migrations:**

   ```bash
   npx drizzle-kit migrate
   ```

5. **Start the Next.js app:**

   ```bash
   npm run dev
   ```

   The app will be available at [http://localhost:3000](http://localhost:3000)

6. **Start the Inngest dev server (in a separate terminal):**

   ```bash
   npx inngest-cli@latest dev
   ```

   Open the Inngest DevServer at [http://127.0.0.1:8288/runs](http://127.0.0.1:8288/runs)

7. Try it out!

Open CampaignCraft at [http://localhost:3000](http://localhost:3000) and click on "Import contacts".
From the import page, select the [examples/realtime/nextjs-bg-jobs-realtime/fake_contacts.csv](examples/realtime/nextjs-bg-jobs-realtime/fake_contacts.csv) file and import it.

You should see the import process run in the Inngest DevServer.

Now navigate to the home page, and click on the "Create Campaign" button. Create a campaign by selecting a segment, generate some AI content and send it. You will see the campaign being sent with realtime updates.

## Notes

- Make sure your `.env` file is correctly configured for all required services.
- The app uses Drizzle ORM for migrations and Neon for the database.
- Inngest is used for background jobs and real-time updates.

For any issues, check the logs in your terminal or review your environment configuration.
