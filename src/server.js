const express = require("express");
const { scrapeStation } = require("./scraper");

const app = express();

app.get("/", (req, res) => {
  res.send("K2 scraper is alive 🚀");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use(express.json({ limit: "1mb" }));

const API_SECRET = process.env.API_SECRET || "k2-dev-secret";

// Auth middleware
function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", hasCookies: !!process.env.VEGVESEN_COOKIES });
});

// POST /scrape — fetch available slots for a station
app.post("/scrape", auth, async (req, res) => {
  const { station_external_id, booking_url } = req.body;
  if (!station_external_id) {
    return res.status(400).json({ error: "Missing station_external_id" });
  }

  const cookies = process.env.VEGVESEN_COOKIES;
  if (!cookies) {
    return res.json({
      success: false,
      error: "No session cookies configured. Set VEGVESEN_COOKIES env var.",
      slots: [],
    });
  }

  try {
    const result = await scrapeStation(station_external_id, cookies);
    res.json(result);
  } catch (err) {
    console.error(`[scrape] Error for ${station_external_id}:`, err.message);
    res.json({ success: false, error: err.message, slots: [] });
  }
});

// POST /update-cookies — update session cookies at runtime
app.post("/update-cookies", auth, (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: "Missing cookies" });
  process.env.VEGVESEN_COOKIES = cookies;
  res.json({ success: true, message: "Cookies updated" });
});

// GET /validate-cookies — test if cookies are still valid
app.get("/validate-cookies", auth, async (_req, res) => {
  const cookies = process.env.VEGVESEN_COOKIES;
  if (!cookies) {
    return res.json({ valid: false, reason: "No cookies configured" });
  }

  try {
    const response = await fetch(
      "https://www.vegvesen.no/dinside/dittforerkort/timebestilling/",
      {
        headers: {
          Cookie: cookies,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
        },
        redirect: "manual",
      }
    );

    // If we get redirected to login, cookies are invalid
    const location = response.headers.get("location") || "";
    if (response.status >= 300 && location.includes("login")) {
      return res.json({ valid: false, reason: "Redirected to login — session expired" });
    }

    const html = await response.text();
    const isLoggedIn = html.includes("idporten-bruker") || html.includes("timebestilling");
    res.json({
      valid: isLoggedIn,
      reason: isLoggedIn ? "Session active" : "Could not verify session",
      status: response.status,
    });
  } catch (err) {
    res.json({ valid: false, reason: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`K2 Scraper running on ${PORT}`);
});
