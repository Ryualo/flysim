# 🪰 AR Fly

A webcam + Three.js + MediaPipe Hands AR experience with an animated fruit fly (from `fly.glb`, a Sketchfab CT scan of Drosophila), cheese interaction, and an optional neuPrint neural-data layer.

## Features

- **Webcam background** — your camera feed as the AR backdrop
- **Fly model** — loads `fly.glb` (a CT-scan mesh) and procedurally animates wings, legs, antennae, plus an idle float
- **Hand interaction** — show your hand and push the fly around; it drifts back to its home spot
- **Cheese** — pinch (thumb + index together) to grab the cheese, drag it, and the fly is attracted to it
- **neuPrint backend** — a secure proxy that keeps your API token server-side (no token in the browser)

## Setup

```bash
npm install
cp .env.example .env   # then add your NEUPRINT_API_TOKEN if needed
npm run dev            # starts server at http://localhost:3000
```

Open `http://localhost:3000` in a browser with a webcam. Allow camera access.

> Note: The fly hand-tracking parts load MediaPipe `hands.js` + `camera_utils.js` from CDN, and Three.js from CDN. Requires an internet connection. neuPrint is optional — the app works without a token (it just shows "Not configured").

## Controls

- **Wave/hover your hand near the fly** → the fly gets pushed away and gently recovers
- **Pinch thumb + index** near the cheese → grab it; move your hand to drag; release to drop
- **Place the cheese close to the fly** → the fly is attracted and drifts toward it

## Files

```
fly.glb         3D fly model (CT scan, no skeleton — procedural animation)
server.js       Express server + neuPrint proxy
index.html      UI page
src/main.js     all client logic (Three.js scene, animation, hands, cheese, neuPrint)
```

## neuPrint

Set `NEUPRINT_API_TOKEN` in `.env`. The server exposes `/api/neuroprint/*` as a proxy to `https://neuprint.janelia.org/api`, so your token is never exposed to the browser. A future "behavior layer" can query neuron connectivity data to drive fly behavior.