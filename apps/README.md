# The App (apps/)

This folder holds the two main programs:

- **`apps/api/`** — the web service. It takes your topic and moves it through the pipeline. It also hosts Neo, the built-in AI assistant.
- **`apps/worker/`** — the behind-the-scenes workers. They do the research, writing, video-making, and publishing jobs.

The test files in this folder check that everything works:

- `roundtrip-test.ts` — the full journey, from topic to published
- `neo-test.ts` — the AI assistant
- `oauth-test.ts` — platform logins
- `prod-test.ts` — safety and security checks
- `live-integration-test.ts` — the full system with a real database and queue
