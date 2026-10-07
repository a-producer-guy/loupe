# CLAUDE.md — Loupe

Loupe is an assistant editor for scripted scenes: a filmmaker drops a scene's footage, Loupe lines every take up with the script, hands back a first assembly with a reason for every shot, and the filmmaker directs changes in plain words. It started as Reelarc Footage's "Autoeditor" pilot and is now its own product, at loupe.reelarc.com until editloupe.com launches.

## Who you're working with

Guy, founder of Reelarc, is not a developer. Explain what you did and what to test in plain English, with no jargon. Before any decision that's hard to undo (database schema, deleting anything, paid services), stop and ask.

## The one rule

**It has to feel like directing an invisible editor.** The labour of editing happens in the background; the person only watches, listens and gives notes. Controls appear when they're needed and disappear after. When in doubt, fewer buttons.

## Stages

1. **Foundation (done):** landing page, open sign-up, accounts, uploads to B2, proxies and web previews, scenes, plan/team/settings pages, the free-plan limit (1 scene, 25 GB).
2. **The cut:** the cloud first-assembly engine (ported from Footage's `first-assembly` branch), the script-centric scene view, Edit/Sound/Color/Preview modes, other takes for a line.
3. **Business:** directing notes, Stripe (customers pay when they export), storage cleanup with reminder emails, the "Keep footage" add-on, team invites.

Work on one stage at a time and stop when it's done.

## Repo layout

```
loupe/
  app/       Next.js app → Vercel (project "loupe", team Reelarc)
  worker/    Node proxy worker with FFmpeg → Railway (Docker)
  scripts/   setup-b2.mjs, setup-supabase.mjs
  SETUP.md   how to set it all up, written for Guy
```

## Stack

Next.js 16 (App Router, `src/proxy.ts`), React 19, Tailwind 4 (tokens in `globals.css`), Drizzle ORM, Supabase Auth (magic link + 6-digit code), Uppy multipart uploads to Backblaze B2 through its S3 API, FFmpeg worker. Fonts: Geist. The character Loupe lives in `components/loupe/` (SVG, with a Three.js version for big stages).

## Accounts and data

- Loupe lives in the retired **Backdrop** Supabase project, next to Backdrop's old tables (leave them alone). Tables are prefixed `loupe_`; the app and worker sign in as `loupe_app`, which can only touch those tables. Row-level security is on for every table.
- Every customer is a `loupe_accounts` row. Members, scenes (`loupe_projects`) and LUTs carry `accountId`. Every route that takes an id goes through `ownedShoot` / `ownedFileByKey` / `ownedLut` in `lib/footage/access.ts`, which return 404 for anything another account owns. Keep it that way; the tests in `test/footage.test.ts` ("accounts") check it.
- Roles: owner, editor, director, viewer. `canWrite` is owner or editor.
- Show Guy every migration before running it (`npm run db:migrate` prints it and waits for "yes").

## Security rules

- Secrets live only in `app/.env.local`, `worker/.env` and the Vercel/Railway settings. Never commit them.
- Browsers never get B2 keys; the app hands out short-lived signed URLs one file or part at a time.
- B2 keys can read and write but not delete. Nothing deletes from B2 until Stage 3's storage cleanup, and that needs Guy's yes first.
- Customer footage is customer footage: never copy it, open it or use it for anything but their scene.

## How to work

- Small steps, a commit after each working step, with a clear message.
- `cd app && npm test` (40+ tests), `npx tsc --noEmit`, `npx eslint src` before committing. Worker: `cd worker && npm test`.
- After each step, tell Guy in one or two sentences what now works and how to see it.
