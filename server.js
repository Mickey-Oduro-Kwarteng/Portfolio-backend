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
  console.error(
    "Missing RESEND_API_KEY or CONTACT_TO_EMAIL. Copy .env.example to .env and fill it in.",
  );
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1); // hosts like Render/Railway sit behind a proxy; needed for correct IPs in rate limiting
app.use(express.json({ limit: "20kb" }));

// Only your site(s) may call this API from a browser
const allowed = ALLOWED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} not allowed`));
    },
    methods: ["GET", "POST"],
  }),
);

// At most 5 messages per visitor every 15 minutes
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too many messages, please try again later" },
});

const LIMITS = {
  name: 100,
  email: 200,
  location: 100,
  budget: 100,
  subject: 200,
  message: 5000,
};

const escapeHtml = (v = "") =>
  String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

async function sendEmail(payload) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`Resend responded ${res.status}: ${await res.text()}`);
  return res.json();
}

// Health check — open this URL in a browser to confirm the server is up (and to wake it on free tiers)
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "portfolio-backend" }),
);

app.post("/api/contact", contactLimiter, async (req, res) => {
  const body = req.body || {};

  // Honeypot filled in → bot. Pretend success so it doesn't retry.
  if (body.website) return res.json({ ok: true });

  const data = {};
  for (const [key, max] of Object.entries(LIMITS))
    data[key] = String(body[key] ?? "")
      .trim()
      .slice(0, max);

  if (!data.name || !data.subject || !data.budget || !data.message) {
    return res
      .status(400)
      .json({ error: "please fill in all required fields" });
  }
  if (!/^\S+@\S+\.\S+$/.test(data.email)) {
    return res
      .status(400)
      .json({ error: "that email address doesn't look right" });
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
      text: [...rows.map(([k, v]) => `${k}: ${v}`), "", data.message].join(
        "\n",
      ),
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

// ---------------------------------------------------------------------------
// Medium posts: GET /api/medium?user=yourname
// Medium's RSS feed can't be read from a browser (CORS), so the server fetches it,
// turns it into JSON, and caches it for 30 minutes. Medium's feed holds your 10 latest posts.
// ---------------------------------------------------------------------------
const mediumCache = new Map(); // username -> { at, data }
const MEDIUM_TTL = 30 * 60 * 1000;

const decode = (str = "") =>
  str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

const tag = (xml, name) => {
  const m = xml.match(
    new RegExp(
      `<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`,
    ),
  );
  return m ? m[1].trim() : "";
};

function parseMediumFeed(xml) {
  return xml
    .split("<item>")
    .slice(1)
    .map((chunk) => {
      const item = chunk.split("</item>")[0];
      const content = tag(item, "content:encoded");
      const text = decode(
        content
          .replace(/<figcaption[\s\S]*?<\/figcaption>/g, "")
          .replace(/<[^>]+>/g, " "),
      )
        .replace(/\s+/g, " ")
        .trim();
      const image = content.match(/<img[^>]+src="([^"]+)"/)?.[1] || null;
      const categories = [
        ...item.matchAll(
          /<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g,
        ),
      ].map((m) => decode(m[1].trim()));
      const link = (tag(item, "link") || tag(item, "guid")).split("?")[0];

      return {
        title: decode(tag(item, "title")),
        link,
        date: new Date(tag(item, "pubDate")).toISOString(),
        image,
        tags: categories,
        excerpt: text.slice(0, 160) + (text.length > 160 ? "…" : ""),
        readMinutes: Math.max(1, Math.round(text.split(" ").length / 230)),
      };
    })
    .filter((p) => p.title && p.link);
}

app.get("/api/medium", async (req, res) => {
  const user = String(req.query.user || "")
    .replace(/^@/, "")
    .trim();
  if (!/^[A-Za-z0-9_.-]{1,50}$/.test(user)) {
    return res.status(400).json({ error: "add ?user=yourMediumUsername" });
  }

  const cached = mediumCache.get(user);
  if (cached && Date.now() - cached.at < MEDIUM_TTL) {
    res.set("Cache-Control", "public, max-age=900");
    return res.json(cached.data);
  }

  try {
    const r = await fetch(`https://medium.com/feed/@${user}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (portfolio-backend)",
        Accept: "application/rss+xml, application/xml",
      },
    });
    if (r.status === 404)
      return res.status(404).json({ error: "medium user not found" });
    if (!r.ok) throw new Error(`Medium responded ${r.status}`);

    const data = {
      profile: `https://medium.com/@${user}`,
      posts: parseMediumFeed(await r.text()),
    };
    mediumCache.set(user, { at: Date.now(), data });
    res.set("Cache-Control", "public, max-age=900");
    res.json(data);
  } catch (err) {
    console.error("Medium fetch failed:", err.message);
    if (cached) return res.json(cached.data); // serve stale posts rather than nothing
    res.status(502).json({ error: "couldn't load Medium posts" });
  }
});

// ---------------------------------------------------------------------------
// Link preview: GET /api/preview?url=https://medium.com/@you/post
// Reads the page's share image (og:image) so blog cards show the real cover.
// Only Medium links are allowed (plus any hosts in PREVIEW_EXTRA_HOSTS), so this
// can't be used to fetch arbitrary sites. Results are cached for 24 hours.
// ---------------------------------------------------------------------------
const previewCache = new Map(); // url -> { at, data }
const PREVIEW_TTL = 24 * 60 * 60 * 1000;
const extraHosts = (process.env.PREVIEW_EXTRA_HOSTS || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const isAllowedHost = (host) =>
  host === "medium.com" ||
  host.endsWith(".medium.com") ||
  extraHosts.includes(host);

function metaContent(html, names) {
  for (const name of names) {
    const esc = name.replace(/[:.]/g, "\\$&");
    const a = html.match(
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']+)["']`,
        "i",
      ),
    );
    const b = html.match(
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${esc}["']`,
        "i",
      ),
    );
    const value = (a || b)?.[1];
    if (value) return decode(value);
  }
  return null;
}

app.get("/api/preview", async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ""));
  } catch {
    return res.status(400).json({ error: "add ?url=https://medium.com/..." });
  }
  if (
    target.protocol !== "https:" ||
    !isAllowedHost(target.hostname.toLowerCase())
  ) {
    return res.status(400).json({ error: "only Medium links are supported" });
  }
  target.search = ""; // drop tracking params so cache keys match
  const key = target.toString();

  const cached = previewCache.get(key);
  if (cached && Date.now() - cached.at < PREVIEW_TTL) {
    res.set("Cache-Control", "public, max-age=86400");
    return res.json(cached.data);
  }

  try {
    const r = await fetch(key, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; portfolio-link-preview)",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`page responded ${r.status}`);
    const html = (await r.text()).slice(0, 600_000); // meta tags are near the top

    const data = {
      image: metaContent(html, [
        "og:image",
        "twitter:image",
        "twitter:image:src",
      ]),
      title: metaContent(html, ["og:title", "twitter:title"]),
    };
    previewCache.set(key, { at: Date.now(), data });
    res.set("Cache-Control", "public, max-age=86400");
    res.json(data);
  } catch (err) {
    console.error("Preview failed:", key, err.message);
    if (cached) return res.json(cached.data);
    res.status(502).json({ error: "couldn't read that page" });
  }
});

// CORS rejections and bad JSON end up here
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res
    .status(err.message?.startsWith("Origin") ? 403 : 400)
    .json({ error: "request not allowed" });
});

app.listen(PORT, () => {
  console.log(`Portfolio backend running on port ${PORT}`);
  console.log(`Allowed origins: ${allowed.join(", ")}`);
});
