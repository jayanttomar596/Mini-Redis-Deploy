# Deployment Guide

This project contains a C++ TCP backend and a browser dashboard. A normal static host is not enough for the full app because the dashboard needs a live Node.js bridge and a running Mini Redis backend.

## Recommended Free Deployment

Use **Render Free Web Service** for the live demo link. This repo now deploys with Docker so Render gets the exact C++ and Node.js environment the project needs.

Why Render:

- It can build and run the Node.js dashboard plus the C++ backend in one container.
- It supports WebSocket connections.
- The Node bridge can start the compiled C++ Mini Redis backend internally.
- It gives a public HTTPS URL suitable for GitHub and resume demos.

Important limitation:

- Render Free services can sleep when inactive and wake up on the next HTTP/WebSocket request.
- No third-party platform can honestly guarantee "free forever" forever. Render is the easiest free live-link path. Oracle Cloud Always Free is closer to always-on infrastructure, but it requires VM setup and more operations work.

## How This Deployment Works

```text
Public Browser
      |
      v
Render HTTPS URL
      |
      v
Node.js Dashboard + WebSocket Bridge
      |
      v
Local TCP connection inside Render container
      |
      v
C++ Mini Redis backend on 127.0.0.1:8080
```

The C++ backend is not exposed directly to the internet. Only the dashboard/bridge is public.

## Files Added For Deployment

- `render.yaml`: Render Blueprint configuration.
- `Dockerfile`: installs C++ build tools, compiles `MiniRedis/app`, and starts the Node dashboard.
- `.dockerignore`: keeps local binaries, logs, and development files out of the deploy image.
- `web-dashboard/server.js`: supports Render's `PORT` and optional backend autostart.

## Render Deployment Steps

1. Push this repository to GitHub.

2. Go to Render:

   ```text
   https://render.com
   ```

3. Sign in with GitHub.

4. Click:

   ```text
   New + -> Blueprint
   ```

5. Select this repository.

6. Render should detect `render.yaml`.

7. Confirm the service:

   ```text
   name: mini-redis-dashboard-live
   plan: free
   runtime: docker
   ```

8. Click:

   ```text
   Apply
   ```

9. Wait for the build to finish.

10. Render will give you a live URL like:

   ```text
   https://mini-redis-dashboard-live.onrender.com
   ```

11. Open the URL.

12. Test commands in the dashboard:

   ```redis
   SET deployed yes
   GET deployed
   INCR visits
   GET visits
   ```

## Expected Docker Build

Render builds the root `Dockerfile`. During the build it runs:

```bash
make -C MiniRedis clean app
cd web-dashboard && npm install --omit=dev
```

This compiles the C++ backend binary:

```text
MiniRedis/app
```

## Expected Start Command

The Docker container starts with:

```bash
node server.js
```

The Dockerfile sets `MINI_REDIS_AUTOSTART=1`, which tells the Node bridge to start `MiniRedis/app` internally.

## Local Deployment Simulation

From the repo root:

```bash
cd MiniRedis
make app
cd ../web-dashboard
MINI_REDIS_AUTOSTART=1 PORT=5173 node server.js
```

Open:

```text
http://127.0.0.1:5173
```

In this mode, you do not manually run `./app`; Node starts it for you.

## Notes For Resume/GitHub Demo

After deployment, add the Render link to:

- `README.md`
- GitHub repository About section
- Resume project section
- Demo video description

Suggested resume line:

```text
Built and deployed Mini Redis, a C++ in-memory key-value store with WAL, snapshotting, TTL, LRU, replication, and a WebSocket dashboard that visualizes multi-client TCP sessions.
```

## If Render Build Fails

Check these common causes:

1. Render still shows `runtime: node`
   - Do not reuse the old failed Node service. Render does not allow changing an existing service runtime from Node to Docker. Create a new Blueprint from the updated repo, or delete the old failed service first.

2. Docker build fails while installing packages
   - Retry deploy once. This usually means a temporary package mirror/network issue during image build.

3. Dashboard opens but shows disconnected
   - Check logs for `Mini Redis backend exited`.
   - Confirm `MINI_REDIS_AUTOSTART=1` is set.

4. Service sleeps
   - This is normal on Render Free.
   - First request after inactivity may take time to wake up.
