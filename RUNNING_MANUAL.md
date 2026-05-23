# Mini Redis Running Manual

This project has two runnable parts:

- `MiniRedis/`: C++20 raw TCP Mini Redis backend, terminal client, and optional slave process.
- `web-dashboard/`: Node.js WebSocket bridge plus browser dashboard.

The C++ backend listens on `127.0.0.1:8080`. The dashboard listens on `127.0.0.1:5173`.

## Requirements

- macOS or Linux terminal
- C++20 compiler (`g++` or `clang++`)
- Node.js 20+

## Folder Rule

From the repo root, backend commands run from:

```bash
cd MiniRedis
```

From the repo root, dashboard commands run from:

```bash
cd web-dashboard
```

Do not run `npm start` inside `MiniRedis/`; that folder is only for the C++ backend.

## Run Backend Only

Terminal 1:

```bash
cd MiniRedis
make
./app
```

Terminal 2:

```bash
cd MiniRedis
./client
```

Try:

```redis
SET name Jayant
GET name
EXISTS name
SET otp 1234 EX 10
TTL otp
INCR counter
DECR counter
DEL name
```

Exit the terminal client with:

```redis
EXIT
```

## Run With Web Dashboard

Terminal 1:

```bash
cd MiniRedis
make
./app
```

Terminal 2:

```bash
cd web-dashboard
npm start
```

Open:

```text
http://127.0.0.1:5173
```

Dashboard features:

- Browser CLI for raw Mini Redis commands.
- Key Explorer for observed active keys.
- Multi-Client Map for browser tabs, bridge, and backend.
- Client Sessions panel showing one session per browser tab.
- Recent Activity timeline shared across all dashboard tabs.

## Multi-Client Dashboard Demo

1. Start the backend with `./app`.
2. Start the dashboard with `npm start`.
3. Open `http://127.0.0.1:5173` in three browser tabs.
4. Each tab appears as a separate client session.
5. In Tab 1:

```redis
SET counter 1
```

6. In Tab 2:

```redis
INCR counter
```

7. In Tab 3:

```redis
GET counter
```

Expected:

```text
2
```

This demonstrates multiple frontend clients sharing one C++ in-memory datastore.

## Run Master-Slave Replication

Terminal 1, master:

```bash
cd MiniRedis
./app
```

Terminal 2, slave:

```bash
cd MiniRedis
./app slave 8080
```

Terminal 3, client:

```bash
cd MiniRedis
./client
```

Writes such as `SET`, `DEL`, `INCR`, and `DECR` are forwarded from master to slave after initial snapshot sync.

## Persistence Files

The backend writes persistence files relative to the folder where `./app` is started.

When started from `MiniRedis/`:

```text
MiniRedis/data.log
MiniRedis/snapshot.rdb
```

## Common Errors

`npm error enoent Could not read package.json`

You ran `npm start` from the wrong folder. Use:

```bash
cd web-dashboard
npm start
```

`Undefined symbols for architecture arm64`

You compiled only `main.cpp`. Use:

```bash
cd MiniRedis
make
```

Dashboard shows `Disconnected`

Start the C++ backend:

```bash
cd MiniRedis
./app
```

## Stop Everything

- Stop backend: `Ctrl + C`
- Stop dashboard: `Ctrl + C`
- Stop terminal client: `EXIT`
- Stop dashboard client: close the browser tab
