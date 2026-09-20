# spen-meta-leadgen

Meta Lead Gen webhook handler. Auto-creates ClickUp tasks in your leads list whenever someone submits a Facebook/Instagram lead gen form.

## How it works

1. Meta sends a webhook POST to `/leadgen` when a lead form is submitted
2. The service fetches full lead details from the Graph API
3. Deduplicates by phone number and email against existing ClickUp tasks
4. Creates a new task with all fields mapped (name, phone, email, school, source, program)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CLICKUP_API_TOKEN` | Yes | ClickUp API token (pk_...) |
| `META_PAGE_ACCESS_TOKEN` | Yes | Long-lived Facebook Page access token |
| `META_VERIFY_TOKEN` | No | Webhook verify token (default: `spen-leadgen-2026`) |
| `CLICKUP_LEADS_LIST_ID` | No | Target list ID (default: `901821803899`) |
| `PORT` | No | Server port (default: `3000`) |

## Deploy to Railway

1. Create a new Railway project from this GitHub repo
2. Set the environment variables above
3. Railway auto-deploys on push to `main`
4. Note the Railway public URL (e.g. `https://spen-meta-leadgen-xxx.up.railway.app`)

## Meta Webhook Setup

1. Go to [Meta Developer Console](https://developers.facebook.com)
2. Select your app > Webhooks > Page
3. Subscribe to the `leadgen` field
4. Callback URL: `https://YOUR-RAILWAY-URL/leadgen`
5. Verify token: `spen-leadgen-2026` (or your custom `META_VERIFY_TOKEN`)

## Getting a Long-Lived Page Access Token

1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Select your app, generate a User Token with `pages_manage_ads`, `pages_read_engagement`, `leads_retrieval` permissions
3. Exchange for a long-lived token:
   ```
   GET /oauth/access_token?grant_type=fb_exchange_token
     &client_id=APP_ID&client_secret=APP_SECRET
     &fb_exchange_token=SHORT_LIVED_TOKEN
   ```
4. Get the Page token:
   ```
   GET /me/accounts?access_token=LONG_LIVED_USER_TOKEN
   ```
5. The page token from step 4 is already long-lived (never expires)

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Health check |
| GET | `/leadgen` | Meta webhook verification |
| POST | `/leadgen` | Meta webhook handler (auto-creates tasks) |
| GET | `/leadgen/sync?form_id=XXX&limit=100` | Manual backfill from a lead form |

## Custom Field Mapping

Meta form fields are auto-mapped to ClickUp custom fields:

| Meta Field | ClickUp Field |
|---|---|
| `full_name` | Task name |
| `phone_number` | Phone Number |
| `email` | Email |
| `school_name` | School Name |
| Campaign context | Source (dropdown) |
| Campaign context | Program (dropdown) |
| `age_group` | Age Group (dropdown) |
| `subject` | Subject |
