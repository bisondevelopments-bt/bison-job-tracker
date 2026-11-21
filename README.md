# Bison Job Tracker

The project tracker for Bison Developments' homes, hosted on GitHub Pages with its data in Supabase.

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| The app | `app/tracker.html` → GitHub Pages | Everything people see. Same app that ran in Claude. |
| Adapter | `jt-adapter.js` | Sign-in screen, and connects the app to Supabase (data, files, AI, email). |
| File viewer | `sw.js` | Serves uploaded files at `blob/<id>` from private storage. |
| Database | `supabase/sql/job_tracker.sql` | Table `jt_docs`, file bucket `jt-files`, security rules. All names start with `jt` so BuildTrack is untouched. |
| AI | `supabase/functions/jt-ai` | Holds the AI key on the server. Provider is a setting (Claude, Grok, OpenAI). |
| Email | `supabase/functions/jt-mail` | Sends from the shared Bison Gmail with an app password. |
| Deploy | `.github/workflows/deploy.yml` | On every push: sets up Supabase, then publishes the site. |
| Import | `import.html` | One-time copy of the old tracker's data and files. |

Only logins marked for the Job Tracker (`app_metadata.jt = true`) can read or change its data. The deploy creates the shared team login and marks it.

## GitHub settings (Settings → Secrets and variables → Actions)

**Variables** (not secret):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL, e.g. `https://abcd1234.supabase.co` |
| `SUPABASE_ANON_KEY` | The `anon` public key |
| `TEAM_EMAIL` | The shared team login's email |
| `GMAIL_USER` | `bisondevelopments@gmail.com` |
| `AI_PROVIDER` | Optional: `anthropic` (default), `xai` or `openai` |
| `AI_MODEL_DEFAULT` / `AI_MODEL_QUICK` / `AI_MODEL_COMPLEX` | Optional; required for `xai` and `openai` |

**Secrets**:

| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens |
| `TEAM_PASSWORD` | Password for the team login |
| `ANTHROPIC_API_KEY` | Claude API key (or `XAI_API_KEY` / `OPENAI_API_KEY`) |
| `GMAIL_APP_PASSWORD` | Google Account → Security → App passwords |

Also: **Settings → Pages → Source: GitHub Actions**.

## Changing the app

Edit `app/tracker.html` and push. Within a couple of minutes the site updates.
To pull a newer version from the Claude artifact, replace `app/tracker.html` with it; `scripts/build.py` handles the rest.

## Switching AI provider

Set the `AI_PROVIDER` variable plus that provider's key and model names, then re-run the deploy from the Actions tab.
