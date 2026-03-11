# TravelBuddy Backend

This project wraps your `index.html` frontend with a local Node server and a SQLite database so the app can run end-to-end.

## What it includes

- Static file server for `public/index.html`
- SQLite database at `data/travelbuddy.db`
- Browser SDK shims at `/_sdk/data_sdk.js` and `/_sdk/element_sdk.js`
- REST API for the frontend's current create/update/list flow

## Run

```bash
node server.js
```

Then open http://localhost:3000.

## API

- `GET /api/health`
- `GET /api/data`
- `POST /api/data`
- `GET /api/data/:id`
- `PUT /api/data/:id`
- `DELETE /api/data/:id`

## Data model

The frontend currently stores mixed record types in one collection. This backend keeps that same shape in a single SQLite table:

- `user`
- `group`
- `request`
- `message`

Each saved record gets a `__backendId` plus `created_at` and `updated_at`.

## Notes

- No external npm packages are required.
- The frontend file was copied into `public/index.html` from your original `E:\rtp\index.html`.
- The HTML still uses Tailwind CDN, so an internet connection is helpful for the page styling to load fully.
