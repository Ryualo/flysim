import express from "express";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = Number(process.env.PORT) || 3001;
const TOKEN = process.env.NEUPRINT_API_TOKEN || "";
const BASE = process.env.NEUPRINT_BASE_URL || "https://neuprint.janelia.org/api";

const TIMEOUT_MS = Number(process.env.NEUPRINT_TIMEOUT_MS) || 20000;

const fetchWithTimeout = async (url, init = {}) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
};

// Health check for neuPrint connection
app.get("/api/neuroprint/health", async (_req, res) => {
  if (!TOKEN || TOKEN === "your_token_here") {
    return res.json({ ok: false, message: "No NEUPRINT_API_TOKEN set in .env" });
  }
  try {
    const r = await fetchWithTimeout(`${BASE}/dbmeta/datasets`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!r.ok) return res.json({ ok: false, status: r.status, message: await r.text() });
    // Response is an object keyed by dataset name -> metadata
    const data = await r.json();
    const names = Object.keys(data);
    res.json({ ok: true, count: names.length, datasets: names });
  } catch (e) {
    const msg = e.name === "AbortError" ? `neuPrint timed out after ${TIMEOUT_MS}ms` : e.message;
    res.json({ ok: false, message: msg });
  }
});

// Generic proxy: forwards requests to neuPrint API with auth
app.all("/api/neuroprint/*", async (req, res) => {
  if (!TOKEN || TOKEN === "your_token_here") {
    return res.status(401).json({ error: "No NEUPRINT_API_TOKEN configured" });
  }
  const upstream = `${BASE}/${req.params[0]}`;
  try {
    const init = {
      method: req.method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    };
    if (req.method !== "GET" && req.method !== "HEAD") init.body = JSON.stringify(req.body);
    const r = await fetchWithTimeout(upstream, init);
    const text = await r.text();
    res.status(r.status).type(r.headers.get("content-type") || "application/json").send(text);
  } catch (e) {
    const msg = e.name === "AbortError" ? "neuPrint request timed out" : e.message;
    res.status(502).json({ error: msg });
  }
});

// Auto-fallback: if the port is taken, try the next few.
function listen(port, attempt = 0) {
  const srv = app.listen(port);
  srv.once("listening", () => {
    console.log(`\n  Server running at http://localhost:${port}\n`);
    console.log(`  neuPrint token: ${TOKEN && TOKEN !== "your_token_here" ? "YES ✓" : "NO (set NEUPRINT_API_TOKEN in .env)"}\n`);
  });
  srv.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < 10) {
      console.log(`  Port ${port} is in use, trying ${port + 1}…`);
      listen(port + 1, attempt + 1);
    } else {
      console.error(`  Failed to start: ${err.message}`);
      process.exit(1);
    }
  });
}
listen(PORT);
