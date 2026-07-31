# DarvisXBot

DarvisXBot is a Telegram group and channel management bot backend based on the MVP PRD in `DarvisXBot开发PRD.md`.

## Stack

- Node.js + TypeScript
- grammY for Telegram Bot API
- Fastify for webhook HTTP service
- PostgreSQL + Prisma. Local Docker maps PostgreSQL to `localhost:15433` to avoid conflicts with existing local PostgreSQL instances.
- Redis + BullMQ
- Docker Compose for local infrastructure

## Current Scope

This repository currently implements phase one of the PRD:

- Project bootstrap
- Telegram webhook endpoint
- `/start` inline menu
- `/bind` group/channel binding command
- `/permissions` Bot permission check command
- PostgreSQL schema for MVP entities
- Redis/BullMQ queue definitions
- Local Docker Compose for PostgreSQL, Redis, and the app

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from the example and fill `BOT_TOKEN`:

```bash
cp .env.example .env
```

3. Start PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
```

4. Generate Prisma client and run the first migration:

```bash
npm run prisma:generate
npm run prisma:migrate
```

5. Start the development bot in local polling mode:

```bash
npm run dev
```

With `BOT_MODE=polling`, Telegram messages are received by long polling, so no public HTTPS webhook URL is needed. Send `/start` to the bot in Telegram to test the menu.

With `BOT_MODE=webhook`, the service listens on `http://localhost:3000` and exposes:

- `GET /health`
- `POST /telegram/webhook`

## Telegram Webhook

For production, set `BOT_MODE=webhook`, expose the service over HTTPS, and set the Telegram webhook URL to:

```text
https://your-domain.example/telegram/webhook
```

For local testing, use a tunnel such as Cloudflare Tunnel or ngrok, then call Telegram `setWebhook` with the public HTTPS URL.

## Bot Commands

- `/start`: Show the main menu.
- `/menu`: Show the management menu.
- `/groups`: Select a bound group to manage.
- `/link`: Create a tracked group invite link.
- `/sign_in`: Daily group sign-in for points.
- `/points`: Show your points, or adjust a replied user's points as an admin.
- `/points_rank`: Show the group points ranking.
- `/bind`: Bind the current group/channel after checking the user is an admin and the Bot has required permissions.
- `/permissions`: Show missing Bot admin permissions in the current group/channel.

## Notes

- BotFather privacy mode must be disabled before message filtering/statistics can work in groups.
- The Bot must be added as an administrator to managed groups/channels.
- Payment, AI moderation, and multi-bot tenancy are intentionally outside the current MVP phase.
