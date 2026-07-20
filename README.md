# DutyBoard

A tiny civic-duty board: pick your **city**, post a **duty** (something that needs doing),
**talk it through** in the comments, and **mark it resolved** when it's handled.

DutyBoard is a **plain Vue 3 static site** with **no backend of its own**. The browser talks
directly to [altengine](https://www.altengine.net) as the signed-in end-user — the
"Firestore-style" client model. Three altengine instances do all the work:

| Instance | Service | Role |
| --- | --- | --- |
| `dutyboard-auth` | auth | end-user accounts + identity tokens (sign up / sign in) |
| `dutyboard` | datastore | source of truth for `cities`, `duties`, `comments` |
| `dutyboard-live` | channel | live change events so new posts/comments appear instantly |

**Row-level rules** on the auth instance decide what each user may do — read is open to anyone
signed in, but you can only edit or resolve **your own** duties. Authorship is stamped
server-side from the token, so it can't be forged from the browser. There is **no API key in
this app** — only public instance names and the API URL.

## How it maps to altengine

- **Auth** (`src/lib/altengine.js`) — `signUp` / `signIn` / passwordless / MFA against
  `/v1/auth/dutyboard-auth/*`. The returned `id_token` is stored in `localStorage` and sent as
  `Authorization: Bearer <id_token>` on every data request; a 401 transparently refreshes it.
- **Datastore** — `cities` / `duties` / `comments` via `/v1/datastore/dutyboard/...`. The
  backend AND-injects each user's owner filters into queries and guards writes, so the client
  just reads and writes plainly.
- **Channel** — on write, the datastore→channel bridge publishes a minimal `{op, keys}` event;
  the app subscribes and re-fetches through the access-controlled read path (a live event can
  never leak a row you couldn't read). Live is a **graceful enhancement**: if the channel
  instance isn't configured, the board still works, just without push updates.

### Data model

| Collection | Key | Fields (in `data`) | Rules |
| --- | --- | --- | --- |
| `cities` | slug | `name`, `slug` | read: any signed-in user · create: stamps `author_uid` |
| `duties` | auto uuid | `city_slug`, `title`, `body`, `status` | create stamps author · update/delete own only · `author_uid`/`city_slug` immutable |
| `comments` | auto uuid | `duty_key`, `body` | create stamps author · delete own |

`author_uid` / `author_name` are never sent by the client — the rules' `stamp` sets them from
the verified token (see [`backend/access.json`](backend/access.json)).

## Run it locally

```bash
alt install altlimit/altengine && altengine dev   # the emulator, on :9191
npm install
npm run setup:dev        # provision the 3 instances from backend/ (one time)
npm run dev              # http://localhost:5173
```

`npm run setup:dev` is not optional. Instances *auto-create* on first use, but their
**config** does not: a fresh auth instance collects only an email and grants no access, so
the app would sign a user up and then get `403` on every datastore call. The script applies
[`backend/`](backend/) for you. (Against hosted altengine you do the same thing once in the
console — see [Backend setup](#backend-setup-one-time).)

```bash
npm run build            # static bundle in dist/ — host it anywhere
```

All `VITE_*` values are public. You can also override the target at runtime without rebuilding:
`localStorage.setItem("dutyboard.cfg.baseUrl", "https://api.altengine.net")` (and
`...cfg.auth` / `.datastore` / `.channel` for instance names).

## Backend setup (one time)

Locally, `npm run setup:dev` does all of this for you. Against hosted altengine, create the
three instances in the admin console (same org) and paste the configs from
[`backend/`](backend/):

1. **Auth instance `dutyboard-auth`**
   - **Sign-up form**: paste [`backend/signup.json`](backend/signup.json) (collects `email` +
     display `name`; email is the login identity).
   - **Settings**: enable **Allow signup**. (Optional: enable **Passwordless** to offer the
     "email me a code" button, and **2FA** for TOTP.)
   - **Access rules**: paste [`backend/access.json`](backend/access.json) — this grants the
     auth instance's users scoped access to the `dutyboard` datastore and `dutyboard-live`
     channel, with the per-collection read/create/update/delete rules above.

2. **Datastore instance `dutyboard`**
   - Leave **auto-index ON** (the default) so DutyBoard's queries self-serve. The queries used
     are: `duties WHERE city_slug = ? ORDER BY __created__ DESC` and
     `comments WHERE duty_key = ? ORDER BY __created__ ASC` — auto-index builds these on first
     use. (To pre-declare instead: an index on `duties(city_slug, __created__)` and
     `comments(duty_key, __created__)`.)
   - **Live bridge**: set the `live` config to [`backend/live.json`](backend/live.json) so
     writes to `duties`/`comments` publish to `dutyboard-live` on `duties.<city_slug>` /
     `comments.<duty_key>`.

3. **Channel instance `dutyboard-live`** — no special config; the access template in
   `access.json` already scopes end-users to **subscribe-only** on `duties.*` / `comments.*`,
   and the datastore bridge is the only publisher.

If you name your instances differently, update `.env` (or the `localStorage` overrides) and the
two `channel:` / `datastore:` keys in `backend/access.json` + `channelInstance` in
`backend/live.json` to match.

## Accessibility

Built to WCAG 2.1 AA: semantic landmarks (`<nav>`/`<main>`), one `<h1>` per view, every control
labelled, visible focus indicators, `aria-live` regions for async results and errors,
`aria-invalid` + `aria-describedby` on fields, status shown with **text** (not colour alone),
a skip link, and `prefers-reduced-motion` respected. Layout reflows at 200% zoom with no
horizontal scroll, and both light and dark themes meet contrast minimums.

## What this is not

A demo/example app, intentionally small. No moderation, pagination-past-100, image uploads, or
email-verification flow — those are left as exercises. The point is to show a **complete,
backend-less** app on altengine's auth + datastore + channel with real row-level security.
