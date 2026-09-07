# DEPLOYMENT.md

Runs as a long-lived Node.js process (not serverless — it holds an open
poll loop and an HTTP health server).

```bash
npm ci
npm run build
npm start
```

Point your platform's liveness/readiness probe at `GET /health`. Configure
automatic restart on crash — `main()` exits with code 1 on any
unrecoverable startup error (missing env, invalid network config, RPC/chain
mismatch), which should be treated as "needs operator attention," not
silently retried forever without alerting.
