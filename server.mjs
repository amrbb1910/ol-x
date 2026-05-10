import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const PORT = Number(process.env.PORT || 5173);
const OLX_BASE = "https://www.olx.pl";

const BRAND_SLUGS = {
  abarth: "abarth",
  "alfa romeo": "alfa-romeo",
  audi: "audi",
  bmw: "bmw",
  citroen: "citroen",
  dacia: "dacia",
  fiat: "fiat",
  ford: "ford",
  honda: "honda",
  hyundai: "hyundai",
  jeep: "jeep",
  kia: "kia",
  lexus: "lexus",
  mazda: "mazda",
  "mercedes-benz": "mercedes-benz",
  mercedes: "mercedes-benz",
  mitsubishi: "mitsubishi",
  nissan: "nissan",
  opel: "opel",
  peugeot: "peugeot",
  porsche: "porsche",
  renault: "renault",
  seat: "seat",
  skoda: "skoda",
  suzuki: "suzuki",
  tesla: "tesla",
  toyota: "toyota",
  volkswagen: "volkswagen",
  vw: "volkswagen",
  volvo: "volvo"
};

const BRAND_NAMES = [
  "Abarth",
  "Alfa Romeo",
  "Audi",
  "BMW",
  "Citroen",
  "Dacia",
  "Fiat",
  "Ford",
  "Honda",
  "Hyundai",
  "Jeep",
  "Kia",
  "Lexus",
  "Mazda",
  "Mercedes-Benz",
  "Mitsubishi",
  "Nissan",
  "Opel",
  "Peugeot",
  "Porsche",
  "Renault",
  "Seat",
  "Skoda",
  "Suzuki",
  "Tesla",
  "Toyota",
  "Volkswagen",
  "Volvo"
];

const riskyWords = [
  "anglik",
  "bez prawa",
  "cesja",
  "do naprawy",
  "leasing",
  "pali i jezdzi",
  "pali i jeździ",
  "po szkodzie",
  "powypadk",
  "spalony",
  "uszkodz",
  "zastaw",
  "zamiana"
];

const headers = {
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
};

export function startServer(port = PORT) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host}`);

      if (url.pathname === "/api/deals") {
        const result = await getDeals(url.searchParams);
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/api/brands") {
        sendJson(response, 200, { brands: BRAND_NAMES });
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      console.error(error);
      sendJson(response, 500, {
        error: "Nie udało się wykonać operacji.",
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }).listen(port, () => {
    console.log(`OLX Car Deal Radar działa na http://localhost:${port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

export async function getDeals(params) {
  const filters = normalizeFilters(params);
  const urls = buildSearchUrls(filters);
  const pages = await Promise.allSettled(urls.map((url) => fetchOlx(url)));
  const successfulPages = pages
    .filter((entry) => entry.status === "fulfilled")
    .map((entry) => entry.value);
  const failedPages = pages
    .filter((entry) => entry.status === "rejected")
    .map((entry) => entry.reason?.message || String(entry.reason));

  let listings = uniqueListings(
    successfulPages.flatMap((page) => {
      const parsed = parseOlxPage(page.html, page.url);
      return parsed.map((listing) => ({ ...listing, sourceSearchUrl: page.url }));
    })
  );

  listings = applyLocalFilters(listings, filters);
  const analyzed = analyzeMarket(listings, filters);
  const deals = analyzed
    .filter((listing) => listing.discountPct >= filters.discount)
    .sort((a, b) => b.score - a.score || b.discountPct - a.discountPct || a.price - b.price);

  return {
    filters,
    searchUrls: urls,
    fetchedAt: new Date().toISOString(),
    totalListings: analyzed.length,
    dealCount: deals.length,
    warnings: [
      ...failedPages.map((message) => `Część wyników OLX nie została pobrana: ${message}`),
      ...(successfulPages.length === 0
        ? ["OLX nie zwrócił strony wyników. Spróbuj ponownie za chwilę albo zmniejsz liczbę stron."]
        : []),
      ...(analyzed.length > 0 && deals.length === 0
        ? ["Nie znaleziono ogłoszeń poniżej ustawionego progu. Obniż próg albo rozszerz filtry."]
        : [])
    ],
    listings: analyzed,
    deals
  };
}

function normalizeFilters(params) {
  const brand = clean(params.get("brand") || "");
  const brandSlug = brand ? BRAND_SLUGS[brand.toLowerCase()] || slugify(brand) : "";
  const pages = clamp(toNumber(params.get("pages"), 2), 1, 5);
  const discount = clamp(toNumber(params.get("discount"), 12), 3, 50);
  const onlyFresh = params.get("fresh") !== "false";

  return {
    brand,
    brandSlug,
    priceFrom: optionalNumber(params.get("priceFrom")),
    priceTo: optionalNumber(params.get("priceTo")),
    yearFrom: optionalNumber(params.get("yearFrom")),
    yearTo: optionalNumber(params.get("yearTo")),
    radius: clamp(toNumber(params.get("radius"), 0), 0, 100),
    pages,
    discount,
    onlyFresh
  };
}

function buildSearchUrls(filters) {
  const path = filters.brandSlug
    ? `/motoryzacja/samochody/${filters.brandSlug}/warszawa/`
    : "/motoryzacja/samochody/warszawa/";

  return Array.from({ length: filters.pages }, (_, index) => {
    const url = new URL(path, OLX_BASE);
    url.searchParams.set("search[order]", "created_at:desc");
    if (filters.radius > 0) url.searchParams.set("search[dist]", String(filters.radius));
    if (filters.priceFrom) url.searchParams.set("search[filter_float_price:from]", String(filters.priceFrom));
    if (filters.priceTo) url.searchParams.set("search[filter_float_price:to]", String(filters.priceTo));
    if (filters.yearFrom) url.searchParams.set("search[filter_float_year:from]", String(filters.yearFrom));
    if (filters.yearTo) url.searchParams.set("search[filter_float_year:to]", String(filters.yearTo));
    if (index > 0) url.searchParams.set("page", String(index + 1));
    return url.toString();
  });
}

async function fetchOlx(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`OLX zwrócił status ${response.status}`);
    }
    const html = await response.text();
    return { url, html };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseOlxPage(html, pageUrl) {
  const stateListings = extractFromPrerenderedState(html);
  if (stateListings.length > 0) {
    return stateListings;
  }
  return extractFromAnchors(html, pageUrl);
}

function extractFromPrerenderedState(html) {
  const scripts = [
    ...html.matchAll(/__PRERENDERED_STATE__\s*=\s*"([\s\S]*?)"\s*;/g),
    ...html.matchAll(/__NEXT_DATA__"[^>]*>\s*([\s\S]*?)\s*<\/script>/g)
  ];

  const listings = [];
  for (const match of scripts) {
    const raw = match[1] || "";
    const parsed = tryParseState(raw);
    if (!parsed) continue;
    collectListingObjects(parsed, listings);
  }

  return uniqueListings(listings.map(normalizeStateListing).filter(Boolean));
}

function tryParseState(raw) {
  const candidates = [
    raw,
    decodeHtml(raw),
    raw.replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON.parse(JSON.parse(`"${candidate.replace(/"/g, '\\"')}"`));
      } catch {
        // Try the next representation.
      }
    }
  }
  return null;
}

function collectListingObjects(value, output, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectListingObjects(item, output, seen);
    return;
  }

  const title = pickText(value, ["title", "name"]);
  const url = pickText(value, ["url", "href", "externalUrl"]);
  const price = pickPriceFromObject(value);
  const params = JSON.stringify(value).toLowerCase();

  if (title && url && price && (params.includes("warszawa") || params.includes("otomoto") || params.includes("olx"))) {
    output.push(value);
  }

  for (const child of Object.values(value)) {
    collectListingObjects(child, output, seen);
  }
}

function normalizeStateListing(item) {
  const title = clean(pickText(item, ["title", "name"]));
  const rawUrl = pickText(item, ["url", "href", "externalUrl"]);
  const url = normalizeLink(rawUrl);
  const price = pickPriceFromObject(item);
  if (!title || !url || !price) return null;

  const serialized = JSON.stringify(item);
  const location = clean(
    pickText(item, ["location", "cityName", "regionName", "districtName"]) ||
      firstMatch(serialized, /(Warszawa[^"\\<]{0,90})/i)
  );
  const year = pickNumberFromObject(item, ["year", "production_year"]) || extractYear(serialized);
  const mileage = pickNumberFromObject(item, ["mileage", "mileage_from"]) || extractMileage(serialized);
  const image = normalizeLink(pickImage(item));
  const dateText = clean(
    pickText(item, ["createdTime", "created_at", "lastRefreshTime", "last_refresh_time", "displayDate"]) ||
      firstMatch(serialized, /(Dzisiaj[^"\\<]{0,20}|Odświeżono[^"\\<]{0,45}|\d{1,2} [a-ząćęłńóśźż]+ \d{4})/i)
  );

  return enrichListing({
    id: pickText(item, ["id", "adId", "listId"]) || url,
    title,
    url,
    price,
    location,
    year,
    mileage,
    image,
    dateText
  });
}

export function extractFromAnchors(html, pageUrl) {
  const decoded = decodeHtml(html);
  const anchors = [...decoded.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const listings = [];

  for (const match of anchors) {
    const href = match[1];
    const innerHtml = match[2];
    if (!looksLikeListingLink(href)) continue;

    const title = clean(stripTags(innerHtml));
    if (!title || title.length < 8) continue;

    const start = Math.max(0, match.index - 900);
    const end = Math.min(decoded.length, match.index + match[0].length + 1400);
    const context = decoded.slice(start, end);
    const after = decoded.slice(match.index + match[0].length, end);
    const price = extractPrice(after) || extractPrice(context);
    const year = extractYear(after) || extractYear(context);
    const mileage = extractMileage(after) || extractMileage(context);

    if (!price || !year) continue;

    const image = extractImage(context, title);
    const location = extractLocation(after) || extractLocation(context);
    const dateText = extractDateText(after) || extractDateText(context);

    listings.push(
      enrichListing({
        id: normalizeLink(href),
        title,
        url: normalizeLink(href, pageUrl),
        price,
        location,
        year,
        mileage,
        image,
        dateText
      })
    );
  }

  return uniqueListings(listings);
}

function looksLikeListingLink(href) {
  return (
    href.includes("/d/oferta/") ||
    href.includes("otomoto.pl") ||
    /\/motoryzacja\/samochody\/.+ID/i.test(href)
  );
}

function applyLocalFilters(listings, filters) {
  return listings.filter((listing) => {
    if (filters.brand && !sameBrand(listing, filters.brand)) return false;
    if (filters.priceFrom && listing.price < filters.priceFrom) return false;
    if (filters.priceTo && listing.price > filters.priceTo) return false;
    if (filters.yearFrom && listing.year && listing.year < filters.yearFrom) return false;
    if (filters.yearTo && listing.year && listing.year > filters.yearTo) return false;
    if (filters.onlyFresh && !isFresh(listing.dateText)) return false;
    return true;
  });
}

export function analyzeMarket(listings, filters) {
  const enriched = listings.map((listing) => {
    const make = inferBrand(listing.title, filters.brand);
    const model = inferModel(listing.title, make);
    return { ...listing, make, model };
  });

  return enriched.map((listing) => {
    const cohort = chooseComparableCohort(listing, enriched);
    const marketPrice = median(cohort.map((item) => item.price));
    const discountPct = marketPrice > 0 ? Math.max(0, Math.round(((marketPrice - listing.price) / marketPrice) * 100)) : 0;
    const confidence = confidenceLabel(cohort.length, listing.model);
    const riskFlags = riskyWords.filter((word) => listing.title.toLowerCase().includes(word));
    const recencyBoost = isFresh(listing.dateText) ? 7 : 0;
    const score = Math.max(0, Math.round(discountPct * 2 + recencyBoost + confidence.weight - riskFlags.length * 8));

    return {
      ...listing,
      marketPrice,
      discountPct,
      score,
      confidence: confidence.label,
      comparableCount: cohort.length,
      riskFlags,
      comparableLabel: cohortLabel(listing, cohort)
    };
  });
}

function chooseComparableCohort(listing, listings) {
  const hasYear = Number.isFinite(listing.year);
  const sameMake = listings.filter((item) => item.make === listing.make);
  const sameModel = sameMake.filter((item) => item.model && item.model === listing.model);
  const modelYear = sameModel.filter((item) => !hasYear || !item.year || Math.abs(item.year - listing.year) <= 3);
  if (modelYear.length >= 4) return modelYear;

  const makeYear = sameMake.filter((item) => !hasYear || !item.year || Math.abs(item.year - listing.year) <= 3);
  if (makeYear.length >= 5) return makeYear;

  if (sameModel.length >= 4) return sameModel;
  if (sameMake.length >= 5) return sameMake;

  const allYear = listings.filter((item) => !hasYear || !item.year || Math.abs(item.year - listing.year) <= 2);
  return allYear.length >= 6 ? allYear : listings;
}

function cohortLabel(listing, cohort) {
  if (cohort.length === 0) return "brak porównania";
  const sameModel = cohort.every((item) => item.model === listing.model && item.make === listing.make);
  const sameMake = cohort.every((item) => item.make === listing.make);
  if (sameModel && listing.model) return `${listing.make} ${listing.model}`;
  if (sameMake) return `${listing.make}, podobny rocznik`;
  return "podobny rocznik / cały wynik";
}

function confidenceLabel(count, hasModel) {
  if (count >= 10 && hasModel) return { label: "wysoka", weight: 12 };
  if (count >= 6) return { label: "średnia", weight: 7 };
  if (count >= 3) return { label: "ostrożna", weight: 2 };
  return { label: "niska", weight: -4 };
}

function enrichListing(listing) {
  const title = clean(listing.title);
  return {
    ...listing,
    title,
    price: Number(listing.price),
    year: listing.year ? Number(listing.year) : null,
    mileage: listing.mileage ? Number(listing.mileage) : null,
    location: clean(listing.location || "Warszawa"),
    dateText: clean(listing.dateText || ""),
    image: listing.image || "",
    url: normalizeLink(listing.url),
    negotiable: /do negocjacji/i.test(`${listing.title} ${listing.priceText || ""}`)
  };
}

function uniqueListings(listings) {
  const seen = new Set();
  const unique = [];
  for (const listing of listings) {
    const key = clean(listing.url || listing.id || listing.title).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(listing);
  }
  return unique;
}

function sameBrand(listing, brand) {
  const inferred = inferBrand(listing.title, brand);
  return inferred.toLowerCase() === normalizeBrand(brand).toLowerCase();
}

function inferBrand(title, fallback = "") {
  const normalized = ` ${title.toLowerCase()} `;
  const match = BRAND_NAMES.find((brand) => normalized.includes(` ${brand.toLowerCase()} `));
  if (match) return normalizeBrand(match);
  if (/ mercedes\b/.test(normalized)) return "Mercedes-Benz";
  if (/\bvw\b/.test(normalized)) return "Volkswagen";
  return normalizeBrand(fallback || clean(title.split(/\s+/)[0] || "Inne"));
}

function normalizeBrand(brand) {
  if (!brand) return "Inne";
  const lower = brand.toLowerCase();
  if (lower === "vw") return "Volkswagen";
  if (lower === "mercedes") return "Mercedes-Benz";
  const known = BRAND_NAMES.find((item) => item.toLowerCase() === lower);
  return known || brand.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferModel(title, make) {
  const words = clean(title)
    .replace(/[|,()[\]{}]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const lowerMake = make.toLowerCase();
  const makeIndex = words.findIndex((word, index) => {
    const joined = `${word} ${words[index + 1] || ""}`.toLowerCase();
    return word.toLowerCase() === lowerMake || joined === lowerMake;
  });

  let start = makeIndex >= 0 ? makeIndex + lowerMake.split(/\s+/).length : 0;
  if (make === "BMW" && words[start]?.toLowerCase() === "seria") {
    return clean(`${words[start]} ${words[start + 1] || ""}`);
  }

  const model = words.slice(start, start + 2).filter((word) => !/^\d{4}$/.test(word)).join(" ");
  return model.length >= 2 ? model : "";
}

function isFresh(dateText) {
  const value = (dateText || "").toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  return (
    value.includes("dzisiaj") ||
    value.includes("today") ||
    value.includes(today) ||
    /\b\d{1,2}:\d{2}\b/.test(value)
  );
}

function median(values) {
  const valid = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!valid.length) return 0;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : Math.round((valid[middle - 1] + valid[middle]) / 2);
}

function pickText(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const found = findKey(value, key);
    if (typeof found === "string" || typeof found === "number") return String(found);
    if (found && typeof found === "object") {
      const nested = pickText(found, ["label", "value", "name", "url", "href"]);
      if (nested) return nested;
    }
  }
  return "";
}

function pickPriceFromObject(value) {
  const direct = pickText(value, ["price", "displayPrice", "priceLabel"]);
  const directPrice = extractPrice(direct);
  if (directPrice) return directPrice;
  return extractPrice(JSON.stringify(value).slice(0, 5000));
}

function pickNumberFromObject(value, keys) {
  const text = pickText(value, keys);
  return text ? parseLooseNumber(text) : null;
}

function pickImage(value) {
  const direct = pickText(value, ["image", "thumbnail", "photo", "src"]);
  if (direct && /^https?:/.test(direct)) return direct;

  const json = JSON.stringify(value);
  return firstMatch(json, /(https?:\\?\/\\?\/[^"\\]+\.(?:jpg|jpeg|png|webp)[^"\\]*)/i)?.replace(/\\\//g, "/") || "";
}

function findKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  const lower = key.toLowerCase();
  for (const [itemKey, itemValue] of Object.entries(value)) {
    if (itemKey.toLowerCase() === lower) return itemValue;
  }
  return undefined;
}

function extractPrice(text) {
  const match = String(text).match(/(\d[\d\s.,]{1,14})\s*zł/i);
  if (!match) return null;
  return parseLooseNumber(match[1]);
}

function extractYear(text) {
  const direct = String(text).match(/\b(19[7-9]\d|20[0-3]\d)\b\s*[-–]\s*[\d\s]{2,10}\s*km/i);
  if (direct) return Number(direct[1]);
  const fallback = String(text).match(/\b(19[7-9]\d|20[0-3]\d)\b/);
  return fallback ? Number(fallback[1]) : null;
}

function extractMileage(text) {
  const match = String(text).match(/\b(19[7-9]\d|20[0-3]\d)\b\s*[-–]\s*([\d\s]{2,10})\s*km/i);
  if (!match) return null;
  return parseLooseNumber(match[2]);
}

function extractLocation(text) {
  const datePattern =
    "(?:Odświeżono\\s*)?(?:Dzisiaj|dzisiaj)\\s*o\\s*\\d{1,2}:\\d{2}|(?:Odświeżono\\s*)?(?:dnia\\s*)?\\d{1,2}\\s+[a-ząćęłńóśźż]+\\s+\\d{4}";
  const match = stripTags(String(text)).match(
    new RegExp(`(Warszawa(?:,\\s*[^-]{2,40})?\\s*-\\s*(?:${datePattern}))`, "i")
  );
  return match ? clean(match[1]) : "";
}

function extractDateText(text) {
  const plain = stripTags(String(text));
  const match = plain.match(/(?:Odświeżono\s*)?(?:Dzisiaj|dzisiaj|Today|today)\s*o\s*\d{1,2}:\d{2}|(?:Odświeżono\s*)?dnia\s*\d{1,2}\s+[a-ząćęłńóśźż]+\s+\d{4}|\d{1,2}\s+[a-ząćęłńóśźż]+\s+\d{4}/i);
  return match ? clean(match[0]) : "";
}

function extractImage(context, title) {
  const altPattern = escapeRegExp(title.slice(0, 50));
  const altImage = context.match(new RegExp(`<img[^>]+(?:alt=["'][^"']*${altPattern}[^"']*["'][^>]+)?src=["']([^"']+)["']`, "i"));
  if (altImage) return normalizeLink(altImage[1]);
  const anyImage = context.match(/<img[^>]+src=["']([^"']+)["']/i);
  return anyImage ? normalizeLink(anyImage[1]) : "";
}

function firstMatch(text, regex) {
  const match = String(text).match(regex);
  return match ? match[1] : "";
}

function stripTags(value) {
  return String(value).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&");
}

function normalizeLink(href, base = OLX_BASE) {
  if (!href) return "";
  const cleaned = href.replace(/\\\//g, "/").trim();
  if (cleaned.startsWith("//")) return `https:${cleaned}`;
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  try {
    return new URL(cleaned, base).toString();
  } catch {
    return cleaned;
  }
}

function clean(value) {
  return decodeHtml(value)
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function parseLooseNumber(value) {
  const normalized = String(value).replace(/[^\d]/g, "");
  return normalized ? Number(normalized) : null;
}

function optionalNumber(value) {
  const parsed = parseLooseNumber(value || "");
  return parsed && parsed > 0 ? parsed : null;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(publicDir, requested));

  if (!filePath.startsWith(publicDir)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType(filePath) });
    response.end(file);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fallback);
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
    }[ext] || "application/octet-stream"
  );
}
