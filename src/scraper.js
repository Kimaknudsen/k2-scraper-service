/**
 * K2 Scraper — Vegvesen driving test availability
 *
 * Strategy:
 *   1. Direct HTTP: Call Vegvesen booking page with session cookies,
 *      extract embedded JSON/API data from the response
 *   2. Playwright fallback: If direct HTTP fails, use headless browser
 *      with injected cookies to navigate the SPA and extract calendar data
 *
 * Session cookies must come from a valid BankID login session.
 * Export them from browser DevTools → Application → Cookies.
 */

const VEGVESEN_BASE = "https://www.vegvesen.no";
const BOOKING_PATH = "/dinside/dittforerkort/timebestilling/";

// Station name → Vegvesen internal ID mapping
// These are the names as they appear in the Vegvesen booking dropdown
const STATION_MAP = {
  risløkka: { name: "Risløkka trafikkstasjon", region: "Oslo" },
  lillestrøm: { name: "Lillestrøm trafikkstasjon", region: "Akershus" },
  billingstad: { name: "Billingstad trafikkstasjon", region: "Akershus" },
  drammen: { name: "Drammen trafikkstasjon", region: "Buskerud" },
  sandvika: { name: "Sandvika trafikkstasjon", region: "Akershus" },
};

/**
 * Parse cookie string into name=value pairs
 */
function parseCookies(cookieStr) {
  return cookieStr
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Strategy 1: Direct HTTP request with session cookies
 *
 * After BankID login, the Vegvesen SPA loads and makes XHR calls.
 * The initial page load often contains embedded state/data that we can parse.
 * If the page makes API calls to internal endpoints, we capture those patterns.
 */
async function fetchDirect(stationExternalId, cookies) {
  console.log(`[direct] Fetching for ${stationExternalId}`);

  const headers = {
    Cookie: cookies,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.7",
    Referer: VEGVESEN_BASE + "/dinside/",
  };

  // Try the booking page directly
  const response = await fetch(VEGVESEN_BASE + BOOKING_PATH, {
    headers,
    redirect: "manual",
  });

  // Check for login redirect
  const location = response.headers.get("location") || "";
  if (response.status >= 300 && location.includes("login")) {
    throw new Error("Session expired — redirected to login");
  }

  const html = await response.text();

  // Look for embedded data in the SPA
  const slots = [];

  // Pattern 1: JSON state embedded in script tags
  const statePatterns = [
    /window\.__INITIAL_STATE__\s*=\s*({.+?});/s,
    /window\.__DATA__\s*=\s*({.+?});/s,
    /window\.__NEXT_DATA__\s*=\s*({.+?});/s,
    /"availableSlots"\s*:\s*(\[.+?\])/s,
    /"ledige"\s*:\s*(\[.+?\])/s,
    /"timebestilling"\s*:\s*({.+?})\s*[,;]/s,
  ];

  for (const pattern of statePatterns) {
    const match = html.match(pattern);
    if (match) {
      try {
        const data = JSON.parse(match[1]);
        const extracted = extractSlotsFromData(data, stationExternalId);
        if (extracted.length > 0) {
          console.log(`[direct] Found ${extracted.length} slots via embedded JSON`);
          return { success: true, slots: extracted, source: "vegvesen-api" };
        }
      } catch {
        // JSON parse failed, continue
      }
    }
  }

  // Pattern 2: Look for API endpoint URLs in the HTML/JS
  const apiPatterns = [
    /["'](\/api\/[^"']*timebestilling[^"']*)["']/gi,
    /["'](\/fp-api\/[^"']*)["']/gi,
    /["'](\/kandidat[^"']*)["']/gi,
    /fetch\(["'](https:\/\/[^"']*vegvesen[^"']*api[^"']*)["']/gi,
  ];

  const discoveredEndpoints = new Set();
  for (const pattern of apiPatterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      discoveredEndpoints.add(m[1]);
    }
  }

  if (discoveredEndpoints.size > 0) {
    console.log(`[direct] Discovered API endpoints:`, [...discoveredEndpoints]);

    // Try each discovered endpoint
    for (const endpoint of discoveredEndpoints) {
      try {
        const apiUrl = endpoint.startsWith("http")
          ? endpoint
          : VEGVESEN_BASE + endpoint;

        const apiRes = await fetch(apiUrl, {
          headers: {
            ...headers,
            Accept: "application/json",
          },
        });

        if (apiRes.ok) {
          const apiData = await apiRes.json();
          const extracted = extractSlotsFromData(apiData, stationExternalId);
          if (extracted.length > 0) {
            console.log(`[direct] Found ${extracted.length} slots via API ${endpoint}`);
            return { success: true, slots: extracted, source: "vegvesen-api" };
          }
        }
      } catch {
        // Endpoint didn't work, try next
      }
    }
  }

  // Pattern 3: HTML calendar parsing (dates with availability markers)
  const datePattern =
    /data-date=["'](\d{4}-\d{2}-\d{2})["'][^>]*(?:available|ledig|active)/gi;
  const dates = [];
  let dm;
  while ((dm = datePattern.exec(html)) !== null) {
    dates.push(dm[1]);
  }

  if (dates.length > 0) {
    // Try to find time slots associated with dates
    const timePattern = /(\d{1,2})[.:](\d{2})/g;
    const times = new Set();
    let tm;
    while ((tm = timePattern.exec(html)) !== null) {
      const h = parseInt(tm[1]);
      if (h >= 7 && h <= 17) {
        times.add(`${String(h).padStart(2, "0")}:${tm[2]}`);
      }
    }

    if (times.size > 0) {
      for (const date of dates) {
        for (const time of times) {
          slots.push({ date, time });
        }
      }
      console.log(`[direct] Found ${slots.length} slots via HTML calendar parsing`);
      return { success: true, slots, source: "vegvesen-api" };
    }
  }

  console.log(`[direct] No slots found via direct HTTP. HTML length: ${html.length}`);
  return { success: false, slots: [], error: "No data extracted from direct request" };
}

/**
 * Extract slots from arbitrary JSON data structure
 */
function extractSlotsFromData(data, stationExternalId) {
  const slots = [];

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;

    // Check if this object looks like a slot
    const date = obj.date || obj.dato || obj.slot_date || obj.slotDate;
    const time = obj.time || obj.tid || obj.slot_time || obj.slotTime || obj.klokkeslett;
    if (date && time) {
      slots.push({ date: normalizeDate(date), time: normalizeTime(time) });
      return;
    }

    // Check if it's an array
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }

    // Recurse into object values
    for (const val of Object.values(obj)) {
      if (val && typeof val === "object") walk(val);
    }
  }

  walk(data);
  return slots.filter((s) => s.date && s.time);
}

function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
}

function normalizeTime(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/^kl\.?\s*/, "").trim();
  const m = s.match(/^(\d{1,2})[.:](\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/**
 * Strategy 2: Playwright with injected cookies
 *
 * Used when direct HTTP can't extract data (SPA requires JS execution).
 */
async function fetchWithPlaywright(stationExternalId, cookieStr) {
  console.log(`[playwright] Launching browser for ${stationExternalId}`);

  let browser;
  try {
    const { chromium } = require("playwright");
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      locale: "nb-NO",
      timezoneId: "Europe/Oslo",
    });

    // Inject cookies
    const cookiePairs = parseCookies(cookieStr);
    const playwrightCookies = cookiePairs.map((c) => {
      const [name, ...valueParts] = c.split("=");
      return {
        name: name.trim(),
        value: valueParts.join("=").trim(),
        domain: ".vegvesen.no",
        path: "/",
      };
    });
    await context.addCookies(playwrightCookies);

    const page = await context.newPage();

    // Capture XHR responses for API data
    const capturedSlots = [];
    page.on("response", async (response) => {
      const url = response.url();
      if (
        url.includes("api") ||
        url.includes("timebestilling") ||
        url.includes("kandidat")
      ) {
        try {
          const json = await response.json();
          const extracted = extractSlotsFromData(json, stationExternalId);
          capturedSlots.push(...extracted);
        } catch {
          // Not JSON, ignore
        }
      }
    });

    await page.goto(VEGVESEN_BASE + BOOKING_PATH, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Wait for the SPA to render
    await page.waitForTimeout(3000);

    // Check if we're logged in
    const isLoginPage = await page.evaluate(() => {
      return (
        document.querySelector(".button--action._js-login-url") !== null ||
        document.body.textContent.includes("Logg inn")
      );
    });

    if (isLoginPage) {
      throw new Error("Session expired — landed on login page");
    }

    // If we captured API data from XHR, use that
    if (capturedSlots.length > 0) {
      console.log(
        `[playwright] Captured ${capturedSlots.length} slots from XHR`
      );
      return {
        success: true,
        slots: capturedSlots,
        source: "playwright-xhr",
      };
    }

    // Try to find and interact with the booking calendar
    // Select exam type (klasse B)
    const examTypeSelector = await page.$(
      'select, [role="listbox"], button:has-text("Klasse B"), button:has-text("Personbil")'
    );
    if (examTypeSelector) {
      await examTypeSelector.click();
      await page.waitForTimeout(1000);

      // Try to select klasse B
      const klasseB = await page.$(
        'option:has-text("B"), [role="option"]:has-text("B"), li:has-text("Personbil")'
      );
      if (klasseB) await klasseB.click();
      await page.waitForTimeout(2000);
    }

    // Look for station selector and select our station
    const stationName =
      STATION_MAP[stationExternalId.toLowerCase()]?.name || stationExternalId;
    const stationSelector = await page.$(
      `button:has-text("${stationName}"), option:has-text("${stationName}"), [role="option"]:has-text("${stationName}")`
    );
    if (stationSelector) {
      await stationSelector.click();
      await page.waitForTimeout(3000);
    }

    // Check XHR captures again after interactions
    if (capturedSlots.length > 0) {
      return {
        success: true,
        slots: capturedSlots,
        source: "playwright-xhr",
      };
    }

    // Extract from rendered calendar DOM
    const calendarSlots = await page.evaluate(() => {
      const slots = [];

      // Look for calendar date elements
      const dateEls = document.querySelectorAll(
        '[data-date], .calendar td:not(.disabled), [role="gridcell"]:not([aria-disabled="true"])'
      );

      for (const el of dateEls) {
        const date =
          el.getAttribute("data-date") ||
          el.getAttribute("aria-label") ||
          el.textContent?.trim();
        if (date) {
          slots.push({ date, time: "00:00" }); // Times need clicking each date
        }
      }

      return slots;
    });

    if (calendarSlots.length > 0) {
      console.log(
        `[playwright] Found ${calendarSlots.length} dates from DOM`
      );
      return {
        success: true,
        slots: calendarSlots,
        source: "playwright-dom",
      };
    }

    return {
      success: false,
      slots: [],
      error: "Could not extract slots from page",
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Main entry: try direct HTTP first, then Playwright fallback
 */
async function scrapeStation(stationExternalId, cookies) {
  // Strategy 1: Direct HTTP
  try {
    const directResult = await fetchDirect(stationExternalId, cookies);
    if (directResult.success && directResult.slots.length > 0) {
      return directResult;
    }
  } catch (err) {
    console.warn(`[scraper] Direct HTTP failed: ${err.message}`);
  }

  // Strategy 2: Playwright fallback
  try {
    const pwResult = await fetchWithPlaywright(stationExternalId, cookies);
    return pwResult;
  } catch (err) {
    console.warn(`[scraper] Playwright failed: ${err.message}`);
    return {
      success: false,
      error: `Both strategies failed. Direct: session error. Playwright: ${err.message}`,
      slots: [],
    };
  }
}

module.exports = { scrapeStation };
