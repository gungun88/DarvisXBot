# Repository Guidelines

## Project Structure

- `src/` contains the application TypeScript. Telegram handlers and feature flows live in `src/telegram/`; shared infrastructure is in `src/lib/`; domain services/workers are grouped under `src/chats/`, `src/giveaways/`, `src/scheduled-messages/`, and `src/users/`.
- `src/index.ts` is the runtime entry point; `src/server.ts` owns the Fastify HTTP service.
- `prisma/schema.prisma` and `prisma/migrations/` define the PostgreSQL data model and migrations.
- `src/telegram/*.test.ts` contains the current Node test suite. `dist/` is generated output and should not be edited.

## Build, Test, and Development

Run `npm install` after cloning. For local infrastructure, use `docker compose up -d postgres redis`, then create `.env` from `.env.example` and set required credentials.

- `npm run dev` runs the bot with `tsx watch` for local development.
- `npm run build` type-checks and emits JavaScript to `dist/`.
- `npm run lint` runs the TypeScript compiler in no-emit mode.
- `npm test` runs all `src/telegram/*.test.ts` tests through Node's test runner.
- `npm run prisma:generate` regenerates the Prisma client; `npm run prisma:migrate` applies a development migration.
- `npm run prisma:studio` opens Prisma Studio for inspecting local data.

## Coding Style and Naming

Use strict TypeScript settings from `tsconfig.json`, ES modules, four-space indentation, and semicolons consistent with existing files. Use `camelCase` for variables/functions, `PascalCase` for classes/types, and kebab-case filenames such as `join-verification.ts`. Keep Telegram callback parsing and permission checks close to the feature that owns them; put reusable clients/configuration in `src/lib/`.

## Testing Guidelines

Add focused tests beside the implementation as `<feature>.test.ts` (for example, `src/telegram/join-verification.test.ts`). Exercise parsing, authorization, and state transitions without requiring live Telegram, PostgreSQL, or Redis services. Run `npm test` and `npm run lint` before submitting changes.

## Commits and Pull Requests

Existing commits use short imperative summaries, sometimes with a `feat:` prefix (for example, `Add comment sofa channel tools`). Follow that style, keep each commit focused, and explain schema or behavior changes in the body when needed. Pull requests should describe user-visible behavior, list validation commands, call out required environment or migration steps, and include screenshots or Telegram reproduction details for interaction changes. Never commit `.env`, bot tokens, database passwords, or Redis credentials.
