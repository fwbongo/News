# Trading News App

Shared iOS + web app (Expo) plus a lightweight Node API that scrapes Forex Factory for headlines.
The API stores users and watchlists in a local SQLite database.

## Requirements
- Node.js 20+

## Run the API
```bash
cd apps/api
npm install
npm run dev
```

## Run the app
```bash
cd apps/mobile
npm install
npm run ios   # or npm run web
```

## PWA install (web)
1. Run `npm run web`.
2. Open the app in Chrome or Safari.
3. Use "Install App" (Chrome) or "Add to Home Screen" (Safari).

### API base URL
For a device, set `EXPO_PUBLIC_API_BASE_URL` to your computer's LAN IP, e.g.
```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.10:4000
```

Copy `apps/mobile/.env.example` to `apps/mobile/.env` and adjust as needed.

## Auth notes
Set `JWT_SECRET` in `apps/api/.env` for production use.

## Alerts + push
Push notifications use Expo push tokens and require a physical device.
The API polls Forex Factory for matches and sends push notifications via Expo.

## Deployment notes
If you deploy the web app, deploy the API too and set `EXPO_PUBLIC_API_BASE_URL`
to the API URL (or serve the API under the same domain).
