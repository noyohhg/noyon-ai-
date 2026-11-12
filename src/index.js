import express from "express";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";

const app = express();
app.use(express.json({ limit: "64kb" }));
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.NEXORA_WORKER_TOKEN;
const API_ID = Number(process.env.TELEGRAM_API_ID || 0);
const API_HASH = process.env.TELEGRAM_API_HASH || "";
const SESSION = process.env.TELEGRAM_SESSION || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const ALLOWED = new Set((process.env.ALLOWED_CHAT_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
const client = new TelegramClient(new StringSession(SESSION), API_ID, API_HASH, { connectionRetries: 5 });
let connected = false;
let loginCode = null;

function auth(req, res, next) {
  const supplied = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || supplied !== TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.get("/health", (_req, res) => res.json({ ok: true, telegram: connected }));
app.use("/api", auth);

app.post("/api/login/send-code", async (req, res) => {
  try {
    if (!API_ID || !API_HASH) return res.status(503).json({ error: "Telegram API credentials are not configured" });
    const phone = String(req.body.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone is required" });
    if (!client.connected) await client.connect();
    loginCode = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    res.json({ ok: true, phoneCodeHash: loginCode.phoneCodeHash });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/login/verify-code", async (req, res) => {
  try {
    const { phone, code, phoneCodeHash, password } = req.body || {};
    if (!phone || !code || !phoneCodeHash) return res.status(400).json({ error: "phone, code and phoneCodeHash are required" });
    try {
      await client.invoke(new (await import("telegram/tl/index.js")).Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
    } catch (e) {
      if (String(e.errorMessage || e.message).includes("SESSION_PASSWORD_NEEDED")) {
        if (!password) return res.status(202).json({ needs2FA: true });
        await client.signInWithPassword({ apiId: API_ID, apiHash: API_HASH }, { password: async () => password, onError: err => { throw err; } });
      } else throw e;
    }
    connected = true;
    res.json({ ok: true, sessionString: client.session.save(), warning: "Store this session securely; never share it." });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/me", async (_req, res) => {
  try { const me = await client.getMe(); res.json({ connected: true, id: String(me.id), username: me.username || null }); }
  catch { res.json({ connected: false }); }
});

app.post("/api/config/chats", (req, res) => {
  const ids = Array.isArray(req.body.chatIds) ? req.body.chatIds.map(String) : [];
  ALLOWED.clear(); ids.forEach(id => ALLOWED.add(id));
  res.json({ ok: true, count: ALLOWED.size, note: "For persistence set ALLOWED_CHAT_IDS in Railway variables." });
});

app.post("/api/auto-reply', async (_req, res) => res.status(501).json({ error: "Dashboard bridge is not connected yet." }));

async function replyWithGemini(message) {
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(GEMINI_KEY), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: "Reply naturally and briefly to this message.\n" + message }] }], generationConfig: { maxOutputTokens: 250 } })
  });
  if (!r.ok) throw new Error("Gemini API returned " + r.status);
  const data = await r.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || "";
}

async function boot() {
  if (API_ID && API_HASH && SESSION) {
    await client.start({ phoneNumber: async () => "", phoneCode: async () => "", password: async () => "", onError: e => console.error("Telegram:", e.message) });
    connected = true;
    client.addEventHandler(async event => {
      const msg = event.message;
      if (!msg?.message || msg.out || !ALLOWED.has(String(msg.chatId))) return;
      try { const answer = await replyWithGemini(msg.message); if (answer) await msg.reply({ message: answer }); }
      catch (e) { console.error("Auto reply failed:", e.message); }
    }, new NewMessage({ incoming: true }));
  }
  app.listen(PORT, "0.0.0.0", () => console.log("NEXORA worker listening on", PORT));
}
boot().catch(e => { console.error(e); process.exit(1); });
