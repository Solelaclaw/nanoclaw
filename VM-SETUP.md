# SoleLaClawde Production VM Setup

Reproduces the `solela-prod` exe.dev VM running NanoClaw for app.solela.ai.

## Prerequisites

- exe.dev VM (Ubuntu, Docker pre-installed)
- GitHub repo: `https://github.com/Solelaclaw/nanoclaw.git` (fork of nanocoai/nanoclaw)
- Secrets: OneCLI API key, OneCLI Org key, WhatsApp Cloud credentials, Telegram bot token, Axiom OTEL key, web channel token

---

## Step 1 — Install Node.js (LTS) + pnpm + bun

```bash
uvx nodeenv -n lts ~/node
mkdir -p ~/.local/bin
ln -sf ~/node/bin/node ~/.local/bin/node
ln -sf ~/node/bin/npm ~/.local/bin/npm
ln -sf ~/node/bin/npx ~/.local/bin/npx
npm install -g pnpm@10.33.0
ln -sf ~/node/bin/pnpm ~/.local/bin/pnpm
curl -fsSL https://bun.sh/install | bash
```

## Step 2 — Clone the fork

```bash
git clone https://github.com/Solelaclaw/nanoclaw.git ~/nanoclaw
cd ~/nanoclaw
git remote rename origin origin  # already named origin
git remote add upstream https://github.com/nanocoai/nanoclaw.git
```

## Step 3 — Install Telegram adapter (from upstream channels branch)

```bash
git fetch upstream channels
git show upstream/channels:src/channels/telegram.ts > src/channels/telegram.ts
git show upstream/channels:src/channels/telegram-pairing.ts > src/channels/telegram-pairing.ts
git show upstream/channels:src/channels/telegram-pairing.test.ts > src/channels/telegram-pairing.test.ts
git show upstream/channels:src/channels/telegram-markdown-sanitize.ts > src/channels/telegram-markdown-sanitize.ts
git show upstream/channels:src/channels/telegram-markdown-sanitize.test.ts > src/channels/telegram-markdown-sanitize.test.ts

# Append self-registration import if missing
grep -q "import './telegram.js';" src/channels/index.ts || echo "import './telegram.js';" >> src/channels/index.ts

# Install adapter package
pnpm install @chat-adapter/telegram@4.27.0
```

## Step 4 — Install dependencies + build

```bash
pnpm install
pnpm install qrcode && pnpm install -D @types/qrcode  # needed by web channel
pnpm install chat@4.27.0 @chat-adapter/whatsapp@4.27.0  # match telegram adapter version
pnpm run build

# Agent runner deps
cd container/agent-runner && ~/.bun/bin/bun install && cd ../..
```

## Step 5 — Apply VM-local code patches

These patches are NOT in the fork — they live as unstashed local modifications:

### 5a. Whisper transcription module

Create `src/modules/whisper-transcribe.ts` — host-side audio transcription via OneCLI gateway → OpenAI Whisper API. Wired into `src/router.ts` to enrich audio attachments before they reach the agent.

### 5b. Dual delivery (`src/delivery.ts`)

After delivering a message to the primary channel, fan out to all other wired messaging groups for the same agent. Import `getMessagingGroupsByAgentGroup` and add the mirror loop after the primary `deliveryAdapter.deliver()` call.

### 5c. Connect URL rewrite fix (`src/connect-url-rewrite.ts`)

Add `"` to the regex character classes so URLs inside JSON strings don't eat past the closing quote:
- `ONECLI_CONNECT_RE_G`: `[^\s)\]]` → `[^\s)\]"]`
- `PROXY_CONNECT_RE_G`: same fix

### 5d. Config (`src/config.ts`)

Add `'OPENAI_API_KEY'` to the `readEnvFile` array.

### 5e. Router (`src/router.ts`)

Import `enrichWithTranscription` and call it on `event.message.content` before `writeSessionMessage`.

## Step 6 — Build the container image

```bash
bash ./container/build.sh
```

## Step 7 — Create `.env`

```bash
cat > ~/nanoclaw/.env << 'EOF'
SOLELACLAWDE_PUBLIC_URL=https://app.solela.ai
SOLELACLAWDE_WEB_CHANNEL_TOKEN=<generate: openssl rand -hex 32>
SOLELACLAWDE_TEMPLATE_AGENT_FOLDER=_template
SOLELACLAWDE_AGENT_MEMORY_MAX=1g
SOLELACLAWDE_AGENT_CPU_MAX=0.5
ONECLI_URL=https://app.onecli.sh
ONECLI_API_KEY=<your oc_ key>
WHATSAPP_ACCESS_TOKEN=<your WhatsApp Cloud token>
WHATSAPP_PHONE_NUMBER_ID=1182229021630933
WHATSAPP_APP_SECRET=<your WhatsApp app secret>
WHATSAPP_VERIFY_TOKEN=<your verify token>
WEBHOOK_PORT=3100
SOLELACLAWDE_WHATSAPP_BOT_PHONE=15145008720
ONECLI_ORG_API_KEY=<your oc_org_ key>
TELEGRAM_BOT_TOKEN=<your telegram bot token>
TZ=Europe/Paris
EOF
```

## Step 8 — Create the template agent group

Put your master `CLAUDE.local.md` in `groups/_template/` — it gets cloned to every new user on signup.

## Step 9 — Mount allowlist

```bash
mkdir -p ~/.config/nanoclaw
echo '{"paths": ["/home/exedev/nanoclaw-mnemon-data"]}' > ~/.config/nanoclaw/mount-allowlist.json
```

## Step 10 — Nginx reverse proxy

```bash
sudo tee /etc/nginx/sites-available/default << 'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    server_name _;

    location /webhook/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:11000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;
        proxy_read_timeout 24h;
        proxy_set_header Connection '';
        chunked_transfer_encoding off;
    }
}
NGINX
sudo nginx -t && sudo systemctl reload nginx
```

## Step 11 — Systemd service

```bash
sudo tee /etc/systemd/system/nanoclaw.service << 'SVC'
[Unit]
Description=NanoClaw
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=exedev
WorkingDirectory=/home/exedev/nanoclaw
ExecStart=/home/exedev/node/bin/node /home/exedev/nanoclaw/dist/index.js
Restart=on-failure
RestartSec=5
Environment=PATH=/home/exedev/.local/bin:/home/exedev/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/home/exedev/nanoclaw/.env

[Install]
WantedBy=multi-user.target
SVC
```

## Step 12 — Systemd OTEL override

```bash
sudo mkdir -p /etc/systemd/system/nanoclaw.service.d
sudo tee /etc/systemd/system/nanoclaw.service.d/override.conf << 'OTEL'
[Service]
Environment="OTEL_EXPORTER_OTLP_ENDPOINT=https://api.axiom.co"
Environment="OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <your-axiom-token>,X-Axiom-Dataset=nanoclaw"
OTEL
```

## Step 13 — Start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nanoclaw
sudo systemctl enable --now nginx
```

## Step 14 — Verify

```bash
curl -s http://127.0.0.1:11000/health
# → {"ok":true}

sudo journalctl -u nanoclaw -n 5 --no-pager
# → NanoClaw running
```

---

## Architecture: app.solela.ai ↔ this VM

```
User browser → app.solela.ai (Vercel/Next.js)
  ↓ auth + OneCLI provisioning
  ↓ POST /admin/provision (creates agent_group, user, wirings)
  ↓ SSE /admin/chat (real-time messages)
  ↓
https://solela-prod.exe.xyz:8000
  ↓ exe.dev HTTPS proxy
  ↓
nginx :8000
  ├── /webhook/* → :3100 (WhatsApp Cloud webhooks)
  └── /* → :11000 (NanoClaw web channel)
        ↓
      NanoClaw host process
        ├── router → inbound.db
        ├── container-runner → docker (per-user OneCLI gateway)
        └── delivery → outbound.db → channel adapters
              ├── web (SSE back to browser)
              ├── whatsapp-cloud (:3100 outbound)
              └── telegram (polling)
```

## Updating

```bash
cd ~/nanoclaw
git stash; git pull origin main; git stash pop
pnpm install --frozen-lockfile
pnpm run build
cd container/agent-runner && ~/.bun/bin/bun install && cd ../..
bash ./container/build.sh  # if container deps changed
sudo systemctl restart nanoclaw
```

## Custom agent images (e.g. Agentalent with @orth/cli)

```bash
cat > /tmp/Dockerfile.custom << 'EOF'
FROM nanoclaw-agent-v2-37e6d0ec:latest
USER root
RUN apt-get update && apt-get install -y python3 python3-pip && rm -rf /var/lib/apt/lists/*
RUN pnpm install -g @orth/cli
USER node
EOF
docker build -t "nanoclaw-agent-v2-37e6d0ec:<agent-group-id>" -f /tmp/Dockerfile.custom ~/nanoclaw/container/

# Register in DB
sqlite3 ~/nanoclaw/data/v2.db "UPDATE container_configs SET image_tag='nanoclaw-agent-v2-37e6d0ec:<agent-group-id>' WHERE agent_group_id='<agent-group-id>'"
```
