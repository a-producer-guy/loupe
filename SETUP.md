# Setting up Loupe (Stage 1)

Six steps, about an hour all together. Claude can do most of the typing. Only you can sign in to GitHub, Supabase, Backblaze, Vercel and Railway, and say yes.

When it's done you have:

- **editloupe.com**: the Loupe website and app (runs on Vercel)
- **the proxy worker**: a small always-on server that makes the Premiere proxies and web previews (runs on Railway)
- **a private Backblaze B2 bucket** called `loupe-footage`, where customers' footage lives
- **the retired Backdrop Supabase project**, reused for Loupe's sign-in and database. Backdrop's old tables stay as they are next to Loupe's. It's completely separate from the Reelarc backend and from Reelarc Footage, so nothing Loupe does can touch them.

Costs: the editloupe.com domain about $11 a year, Supabase whatever Backdrop already costs, Backblaze about $7 per TB per month, Vercel already paid (Reelarc team), Railway a few dollars a month on top of Footage's worker.

---

## 1. GitHub (2 minutes)

On github.com, make a new **private** repository called `loupe` (no README, no .gitignore, nothing ticked). Tell Claude when it's there and Claude pushes the code.

## 2. Supabase: the Backdrop project (15 minutes)

1. On supabase.com, open the **Backdrop** project. If it's paused, click **Restore**.
2. **Project Settings → Database → Reset database password**, and save the new password in a password manager. You'll need it once, in a minute. (Nothing uses Backdrop any more, so changing it breaks nothing.)
3. **Authentication → Hooks**: if any hook is switched on, tell Claude before going further; it could block Loupe's sign-ins.
4. Click Run on this. It shows you exactly what it will add, waits for you to type `yes`, then makes Loupe's tables and saves the connection into the settings files:

   ```bash
   cd app && npm run db:migrate
   ```

   It asks for two things, and neither shows on screen as you paste it:
   - **The connection string**: in Supabase, click **Connect** at the top of the page → **Session pooler** → copy the URI.
   - **The database password** from step 2.

   Because Backdrop still has its old tables, it lists them and asks you to type `backdrop` before it adds anything. It leaves those tables exactly as they are, and it refuses Reelarc Footage's database outright.
5. In Supabase, **Project Settings → API Keys**: copy the **Publishable key**. Click Run on this and paste it when asked:

   ```bash
   node scripts/setup-supabase.mjs
   ```

## 3. Supabase: sign-in emails (10 minutes)

Still in the Backdrop project (these replace Backdrop's old sign-in settings):

1. **Authentication → URL Configuration**
   - Site URL: `https://editloupe.com`
   - Redirect URLs: add `https://editloupe.com/**` and `http://localhost:3210/**`
2. **Authentication → Sign In / Providers**: keep **Allow new users to sign up** on (anyone with the link can start a free scene). Under **Email**, set **Email OTP Length** to **6**.
3. **Authentication → Emails → SMTP Settings**: switch on **Enable Custom SMTP**, then **Save changes**.
   - Host `smtp.resend.com`, port `465`, username `resend` (exactly that)
   - Password: a new Resend API key (Resend → API Keys → Create, name it "Supabase Loupe sign-in (editloupe)", sending access, domain editloupe.com)
   - Sender email `hi@editloupe.com`, sender name `Loupe`
   - editloupe.com is added in Resend → Domains; Resend put its records into Vercel's DNS for the domain by itself.
4. **Authentication → Emails → Templates**: put this in both **Magic link or OTP** and **Confirm sign up**.

   Subject: `Your Loupe sign-in link`

   ```html
   <h2>Sign in to Loupe</h2>
   <p><a href="{{ .ConfirmationURL }}">Click here to sign in</a></p>
   <p>Or type this code on the sign-in page: <strong>{{ .Token }}</strong></p>
   <p>The link and the code work for one hour. If you didn't ask to sign in, you can ignore this email.</p>
   ```

## 4. Backblaze B2 (5 minutes)

Same Backblaze account as Footage, new bucket.

1. On backblaze.com, **Application Keys → Generate New Master Application Key**. Copy the keyID and applicationKey.
   Footage's app and worker use their own restricted keys, not the master key, so making a new master key doesn't affect Footage. If you've used the master key anywhere else, tell Claude first.
2. Click Run on this and paste the two values when asked:

   ```bash
   node scripts/setup-b2.mjs
   ```

   It makes the private `loupe-footage` bucket (keeps every earlier version of each file, lets editloupe.com upload to it) and two restricted keys that can't delete anything. It saves them into the settings files. The master key isn't saved.

## 5. Try it on this Mac

Ask Claude to start it, then open http://localhost:3210 in Chrome, sign in with your email and drop a small scene.

## 6. Put it online (20 minutes, with Claude)

**App → Vercel** (team **Reelarc**, project `loupe`):

1. New project from the `loupe` repository, root directory `app`, preset **Next.js**.
2. Environment variables: everything in `app/.env.local`, plus `APP_URL=https://editloupe.com`. Paste them all at once into the first Key box.
3. Domains: add `editloupe.com`, and `www.editloupe.com` set to redirect to it. The domain is bought through Vercel (Reelarc team), so Vercel sets up its addresses by itself; there's nothing to do in Google Cloud DNS.

**Worker → Railway** (same Hobby account as Footage's worker):

1. New project → the `loupe` repository. Settings: root directory `/worker`, watch path `/worker/**`, region **US East**. No domain or port.
2. Variables → Raw Editor: everything in `worker/.env`.
3. The deploy log should say `Proxy worker … started (2 at a time)`.

From then on, pushing to `main` redeploys both.

---

## Good to know

- **Sign-up is open.** Anyone with the link gets an account and one free scene (up to 25 GB). A second scene asks them to pick a plan; payment comes in Stage 3, so until then you upgrade an account by hand (ask Claude).
- **Your first account:** sign in with guy@reelarc.com. It makes an account called "Reelarc" with you as owner.
- **If Backdrop is on Supabase's free plan, it pauses after a week with no visits.** Open the site now and then, or move it to Pro when real customers arrive.
- **Backdrop's old tables** can be deleted later, once you're sure nothing in them is needed. Ask Claude; nothing deletes them on its own.
- **Nothing is ever deleted from B2 in Stage 1.** The keys can't delete, and the bucket keeps every replaced version.
