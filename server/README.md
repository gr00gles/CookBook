# CookBook server

A small Cloudflare Worker that lets Claude send recipes to the CookBook iPhone app.

- Each person who turns on **Let Claude send recipes** in the app gets their own inbox and a private connector link.
- They add that link to Claude as a custom connector. Claude's `save_recipe` tool drops recipes into their inbox.
- The app collects waiting recipes whenever it's open and then deletes them from the server. Anything not collected is dropped after 30 days.

It runs on Cloudflare's free plan. Each inbox is a Durable Object, so there's no database to set up.

## Deploy

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up). Pick one of these two ways.

**From your Mac** (needs [Node.js](https://nodejs.org) 18 or later):

```sh
cd server
npx wrangler@4 login     # opens a browser to sign in to Cloudflare
npx wrangler@4 deploy
```

**From GitHub, without installing anything:**

1. In Cloudflare, create an API token from the **Edit Cloudflare Workers** template, and copy your **Account ID** from the Workers & Pages page.
2. In this repo on GitHub, go to Settings › Secrets and variables › Actions and add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Go to Actions › **Deploy server** › Run workflow.

Either way, the output ends with your server address, like `https://cookbook-server.your-name.workers.dev`. On your first deploy Cloudflare may ask you to pick the `your-name` part.

Put that address in `ios/project.yml` as `COOKBOOK_SERVER_URL` so every copy of the app you build uses it. You can also type it into the app under Settings › Server.

## API

| Method and path | Who calls it | What it does |
| --- | --- | --- |
| `POST /v1/inboxes` | App | Creates an inbox. Returns `inboxId`, `readKey` and `connectorUrl`. |
| `GET /v1/inboxes/:id/recipes` | App (`Authorization: Bearer <readKey>`) | Recipes waiting for the app. |
| `POST /v1/inboxes/:id/ack` | App | `{"ids": [...]}` deletes collected recipes. |
| `POST /v1/inboxes/:id/connector` | App | Makes a new connector link. The old one stops working. |
| `DELETE /v1/inboxes/:id/connector` | App | Turns sending off. |
| `POST /mcp/<inboxId>.<secret>` | Claude | MCP endpoint (Streamable HTTP, JSON responses) with one tool, `save_recipe`. |

The connector link is the only thing that lets someone add recipes to an inbox, so the app tells people to keep it to their own Claude account. The server stores only hashes of the link secret and the read key.

## Develop

```sh
npm test              # unit tests, no dependencies
npx wrangler@4 dev    # local server on http://localhost:8787
```
