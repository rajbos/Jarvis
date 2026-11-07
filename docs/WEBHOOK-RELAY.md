# GitHub webhook relay (push instead of poll)

## Why

The agent-sessions view asks GitHub, every two minutes, for the state of every
PR a Copilot or Claude session is working on: one batched GraphQL query per
account for the PRs (checks, Copilot review, merge state), the Copilot agent
tasks list, up to 20 task-detail calls, plus the notifications sync and the
auto-dismiss sweep on their own timers. All of it is polling: most sweeps find
nothing new, and every call still costs REST or GraphQL budget.

`githubRequest()` (`src/services/github-api.ts`) now logs every call with its
URL pattern and the feature that made it, and the rate-limit badge popover
shows the tally, so the actual drain can be read off `main.log`:

```
[GitHubAPI] active-sessions:pr-readiness POST /graphql → 200 412ms graphql 4877/5000 https://api.github.com/graphql
[GitHubAPI] notifications-sync:actor GET /repos/{owner}/{repo}/pulls/{n} → 200 180ms core 3120/5000 https://api.github.com/repos/acme/rocket/pulls/77
[GitHubAPI] last 10m: 143 call(s): notifications-sync:actor=96 (GET /repos/{owner}/{repo}/pulls/{n}×61, …); active-sessions:cloud-task-detail=20 (…); …
```

The fix for the polling itself is to be told when something changed. GitHub
does that through webhooks, but Jarvis runs on a laptop without a public
endpoint, so a small relay the user controls sits in between.

## Shape

```
GitHub ──webhook──▶ Azure Function (relay) ◀──poll /events──  Jarvis
         (push)      keeps an event log            (cheap, not rate-limited)
```

1. **GitHub side** — a GitHub App (preferred: fine-grained permissions, one
   webhook for every installed repo) or the existing OAuth app with webhooks
   configured per repo/org. Subscribe to: `pull_request`,
   `pull_request_review`, `check_run`, `check_suite`, `workflow_run`,
   `status`, `issue_comment`. Set a webhook secret.
2. **Relay (Azure Function, HTTP trigger)** — the user's own function app.
   - `POST /api/github` — receives deliveries. Verifies
     `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the webhook
     secret), rejects anything else with 401. Appends an envelope to a log
     (Table Storage / a queue drained into Table Storage / Cosmos — anything
     with a monotonic id) and answers 202. Keep the last ~24h; older rows can
     be purged.
   - `GET /api/events?after=<id>&limit=<n>` — returns the envelopes with
     `id > after`, oldest first. Requires `Authorization: Bearer <relay
     token>` (a secret the user generates; the function compares it in
     constant time). Response:
     ```json
     {
       "events": [
         {
           "id": "000000000042",
           "deliveryId": "6f2a…",
           "event": "check_run",
           "receivedAt": "2026-11-07T12:34:56Z",
           "payload": { "action": "completed", "repository": { "full_name": "acme/rocket" }, "check_run": { "name": "build", "head_sha": "…", "conclusion": "failure", "pull_requests": [{ "number": 77 }] } }
         }
       ],
       "cursor": "000000000042"
     }
     ```
     The relay may trim `payload` to the fields `summarizeWebhookEvent()`
     reads (`repository.full_name`, `action`, `pull_request.number`,
     `pull_request.head.sha`, `issue.number`, `issue.pull_request`,
     `check_run`/`check_suite`/`workflow_run` `{ name, head_sha, status,
     conclusion, pull_requests[].number }`, `sha`, `context`, `state`) to keep
     the log small.
3. **Jarvis side** (`src/services/webhook-relay.ts`) — the
   `github-webhook-relay-poll` background task polls `/events` every 30s when
   the relay is configured, reduces each envelope to "PR X in repo Y changed"
   and keeps a changed-PR set. When an event touches a PR that is in the
   latest agent-sessions snapshot, the sweep runs immediately instead of
   waiting for its two-minute tick.

## Configuration

`%APPDATA%\Jarvis\config.json`:

```json
{
  "webhookRelay": {
    "url": "https://jarvis-relay.azurewebsites.net/api",
    "token": "<relay bearer token>"
  }
}
```

No UI yet; the task shows up in the background tasks list once configured and
is skipped (not failed) while it is not.

## Rollout

| Step | Status | Effect on API calls |
| --- | --- | --- |
| Log every call by purpose + pattern (`githubRequest`) | done | none — measurement |
| Relay client, changed-PR tracking, immediate sweep on a relevant event | done | none yet — polling continues |
| Skip the PR GraphQL batch when the relay is configured and nothing changed | next | removes the 2-minute GraphQL poll |
| Build PR readiness from webhook payloads (check_run / check_suite carry the conclusion) | later | removes the per-PR re-query after a change |
| Notifications sync from `issue_comment` / `pull_request` events instead of `/notifications` + per-subject actor lookups | later | removes the largest REST consumer |
| Copilot agent task updates — no webhook exists; keep the incremental `since=` listing | — | unchanged (own 60/h budget) |

Each step keeps polling as the fallback: when the relay is unreachable the
poll task reports the error and the two-minute sweep keeps going as today.
