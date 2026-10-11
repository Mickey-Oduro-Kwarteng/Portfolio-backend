import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const {
  PORT = 3001,
  RESEND_API_KEY,
  CONTACT_TO_EMAIL,
  CONTACT_FROM_EMAIL = "Portfolio <onboarding@resend.dev>",
  SEND_AUTO_REPLY,
  ALLOWED_ORIGINS = "http://localhost:5173",
} = process.env;

if (!RESEND_API_KEY || !CONTACT_TO_EMAIL) {
  console.error("Missing RESEND_API_KEY or CONTACT_TO_EMAIL. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1); // hosts like Render/Railway sit behind a proxy; needed for correct IPs in rate limiting
app.use(express.json({ limit: "20kb" }));

// Only your site(s) may call this API from a browser
const allowed = ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed`));
    },
    methods: ["POST"],
  })
);

// At most 5 messages per visitor every 15 minutes
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many messages, please try again later" },
});

const LIMITS = { name: 100, email: 200, location: 100, budget: 100, subject: 200, message: 5000 };

const escapeHtml = (v = "") =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function sendEmail(payload) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
  return res.json();
}

// Health check — open this URL in a browser to confirm the server is up (and to wake it on free tiers)
app.get("/", (_req, res) => res.json({ ok: true, service: "portfolio-backend" }));

app.post("/api/contact", contactLimiter, async (req, res) => {
  const body = req.body || {};

  // Honeypot filled in → bot. Pretend success so it doesn't retry.
  if (body.website) return res.json({ ok: true });

  const data = {};
  for (const [key, max] of Object.entries(LIMITS)) data[key] = String(body[key] ?? "").trim().slice(0, max);

  if (!data.name || !data.subject || !data.budget || !data.message) {
    return res.status(400).json({ error: "please fill in all required fields" });
  }
  if (!/^\S+@\S+\.\S+$/.test(data.email)) {
    return res.status(400).json({ error: "that email address doesn't look right" });
  }

  const rows = [
    ["Name", data.name],
    ["Email", data.email],
    ["Location", data.location || "—"],
    ["Budget", data.budget],
    ["Subject", data.subject],
  ];

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;color:#0f172a">
      <h2 style="margin:0 0 16px;color:#9333ea">New message from your portfolio</h2>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;width:90px">${k}</td><td style="padding:6px 0">${escapeHtml(v)}</td></tr>`).join("")}
      </table>
      <p style="margin:20px 0 6px;color:#64748b;font-size:14px">Message</p>
      <div style="white-space:pre-wrap;font-size:15px;line-height:1.6;background:#f8fafc;padding:16px;border-radius:8px">${escapeHtml(data.message)}</div>
      <p style="margin-top:20px;font-size:13px;color:#94a3b8">Hit reply to answer ${escapeHtml(data.name)} directly.</p>
    </div>`;

  try {
    await sendEmail({
      from: CONTACT_FROM_EMAIL,
      to: [CONTACT_TO_EMAIL],
      reply_to: data.email,
      subject: `Portfolio: ${data.subject}`,
      html,
      text: [...rows.map(([k, v]) => `${k}: ${v}`), "", data.message].join("\n"),
    });

    if (SEND_AUTO_REPLY === "true") {
      await sendEmail({
        from: CONTACT_FROM_EMAIL,
        to: [data.email],
        reply_to: CONTACT_TO_EMAIL,
        subject: "Thanks for getting in touch",
        text: `Hi ${data.name},\n\nThanks for your message about "${data.subject}". I've received it and will reply within two working days.\n\nBest,\n${CONTACT_FROM_EMAIL.replace(/<.*>/, "").trim()}`,
      }).catch((err) => console.error("Auto-reply failed:", err.message));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "the email service is unavailable" });
  }
});

// CORS rejections and bad JSON end up here
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(err.message?.startsWith("Origin") ? 403 : 400).json({ error: "request not allowed" });
});

app.listen(PORT, () => {
  console.log(`Portfolio backend running on port ${PORT}`);
  console.log(`Allowed origins: ${allowed.join(", ")}`);
});
