# CU Saathi Server — Render Deployment

## Deploy Steps (Mobile-friendly)

### 1. GitHub par upload karo
1. github.com par naya repository banao (naam: `cu-saathi-server`)
2. "Upload files" dabao
3. Is ZIP ki saari files drag-and-drop karo
4. Commit karo

### 2. Render par deploy karo
1. render.com kholo → "Sign up with GitHub"
2. GitHub authorize karo
3. Dashboard → "New +" → "Web Service"
4. Apna `cu-saathi-server` repo select karo
5. Settings:
   - **Build Command:** `./render-build.sh`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
6. "Create Web Service" dabao
7. 5-10 min me live hoga! URL milega: `https://cu-saathi-server.onrender.com`

### 3. UptimeRobot se always-on rakho
1. uptimerobot.com par free account banao
2. New Monitor → HTTP(s)
3. URL: `https://tumhara-url.onrender.com/health`
4. Interval: 5 minutes
5. Create!

### 4. App me URL update karo
Firebase Remote Config me `server_url` ko naye Render URL se update karo!

## Files
- `server.js` — Express API (dbg-term REMOVED for security)
- `scraper.js` — Puppeteer portal scraper (all fixes included)
- `render.yaml` — Render blueprint
- `render-build.sh` — Chromium install script
