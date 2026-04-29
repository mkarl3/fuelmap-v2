# FuelMAP v2

Cycling race planning and performance analysis.

---

## First-time setup

You need Node.js installed. Download it at https://nodejs.org — get the LTS version.

### Install dependencies
```
npm install
```

### Run locally
```
npm run dev
```
Opens at http://localhost:5173

### Build for production
```
npm run build
```

---

## Deploy to Vercel

### One-time setup

1. Push this repo to GitHub (github.com/Mkarl3/fuelmap-v2)
2. Go to vercel.com → Add New Project → Import from GitHub
3. Select `fuelmap-v2` → Deploy
4. Done. Vercel auto-detects Vite, no config needed.

### Every deploy after that

```
git add .
git commit -m "your change description"
git push
```

Vercel picks up the push and deploys automatically in ~30 seconds.

---

## Project structure

```
fuelmap-v2/
├── index.html          — HTML entry point
├── package.json        — dependencies
├── vite.config.js      — build config
├── vercel.json         — deploy config
├── public/
│   └── favicon.svg     — browser tab icon
└── src/
    ├── main.jsx        — React mount point
    └── App.jsx         — full application
```

---

## Tech stack

- React 18
- Vite 5
- Recharts (charts)
- Deployed on Vercel
