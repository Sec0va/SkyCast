const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(process.cwd(), "public");
const UPDATE_INTERVAL_MS = Number(process.env.UPDATE_INTERVAL_MS || 30000);
const STALE_AFTER_MS = Number(process.env.STALE_AFTER_MS || 25000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000);
const RATE_LIMIT_API = Number(process.env.RATE_LIMIT_API || 90);
const RATE_LIMIT_REFRESH = Number(process.env.RATE_LIMIT_REFRESH || 30);
const RATE_LIMIT_STREAM = Number(process.env.RATE_LIMIT_STREAM || 45);

const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(self), microphone=(), camera=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; connect-src 'self' https://geocoding-api.open-meteo.com https://api.open-meteo.com; img-src 'self' data:; script-src 'self' https://cdn.tailwindcss.com https://fonts.googleapis.com 'unsafe-inline'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com;",
});

const SOURCE_ORDER = ["meteoinfo", "gismeteo", "yandex", "weathercom", "meteoblue", "wunderground"];
const SOURCE_LABEL = {
  meteoinfo: "Meteoinfo.ru",
  gismeteo: "GISMETEO.ru",
  yandex: "Яндекс Погода",
  weathercom: "Weather.com",
  meteoblue: "MeteoBlue",
  wunderground: "Weather Underground",
};

const CITY_ALIASES = {
  moscow: "moscow",
  "moskva": "moscow",
  "\u043c\u043e\u0441\u043a\u0432\u0430": "moscow",
  "saint-petersburg": "saint-petersburg",
  "st-petersburg": "saint-petersburg",
  "\u0441\u0430\u043d\u043a\u0442-\u043f\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433": "saint-petersburg",
  "\u043f\u0438\u0442\u0435\u0440": "saint-petersburg",
  "novosibirsk": "novosibirsk",
  "\u043d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a": "novosibirsk",
  "kazan": "kazan",
  "\u043a\u0430\u0437\u0430\u043d\u044c": "kazan",
};

const CITY_PRESETS = {
  moscow: {
    displayName: "Москва, RU",
    lat: 55.7558,
    lon: 37.6176,
    urls: {
      meteoinfo: "https://meteoinfo.ru/pogoda/russia/moscow-area/moscow",
      gismeteo: "https://www.gismeteo.ru/weather-moscow-4368/",
      yandex: "https://yandex.ru/pogoda/moscow",
      weathercom: "https://weather.com/weather/today/l/55.7558,37.6176",
    },
  },
  "saint-petersburg": {
    displayName: "Санкт-Петербург, RU",
    lat: 59.9343,
    lon: 30.3351,
    urls: {
      meteoinfo: "https://meteoinfo.ru/pogoda/russia/leningrad-area/st-petersburg",
      gismeteo: "https://www.gismeteo.ru/weather-sankt-peterburg-4079/",
      yandex: "https://yandex.ru/pogoda/saint-petersburg",
      weathercom: "https://weather.com/weather/today/l/59.9343,30.3351",
    },
  },
  novosibirsk: {
    displayName: "Новосибирск, RU",
    lat: 55.0084,
    lon: 82.9357,
    urls: {
      meteoinfo: "https://meteoinfo.ru/pogoda/russia/novosibirsk-area/novosibirsk",
      gismeteo: "https://www.gismeteo.ru/weather-novosibirsk-4690/",
      yandex: "https://yandex.ru/pogoda/novosibirsk",
      weathercom: "https://weather.com/weather/today/l/55.0084,82.9357",
    },
  },
  kazan: {
    displayName: "Казань, RU",
    lat: 55.7961,
    lon: 49.1064,
    urls: {
      meteoinfo: "https://meteoinfo.ru/pogoda/russia/tatarstan/kazan",
      gismeteo: "https://www.gismeteo.ru/weather-kazan-4364/",
      yandex: "https://yandex.ru/pogoda/kazan",
      weathercom: "https://weather.com/weather/today/l/55.7961,49.1064",
    },
  },
};

const cityStates = new Map();
const requestBuckets = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const host = req.headers.host || "localhost";
    const requestUrl = new URL(req.url || "/", `http://${host}`);
    const pathname = decodeURIComponent(requestUrl.pathname);
    const method = req.method || "GET";

    if (pathname === "/api/weather" && method === "GET") {
      if (handleRateLimit(res, clientIp, "api", RATE_LIMIT_API, RATE_WINDOW_MS)) {
        return;
      }
      const requestedCity = requestUrl.searchParams.get("city") || "Москва";
      const snapshot = await refreshCity(requestedCity, { force: false });
      return json(res, 200, snapshot);
    }

    if (pathname === "/api/refresh" && method === "POST") {
      if (handleRateLimit(res, clientIp, "refresh", RATE_LIMIT_REFRESH, RATE_WINDOW_MS)) {
        return;
      }
      const requestedCity = requestUrl.searchParams.get("city") || "Москва";
      const snapshot = await refreshCity(requestedCity, { force: true });
      return json(res, 200, snapshot);
    }

    if (pathname === "/api/stream" && method === "GET") {
      if (handleRateLimit(res, clientIp, "stream", RATE_LIMIT_STREAM, RATE_WINDOW_MS)) {
        return;
      }
      const requestedCity = requestUrl.searchParams.get("city") || "Москва";
      return openEventStream(req, res, requestedCity);
    }

    if (pathname.startsWith("/api/")) {
      return json(res, 405, { error: "Method not allowed" });
    }

    if (pathname === "/health" && method === "GET") {
      return json(res, 200, { ok: true, service: "weather-multi-source-dashboard" });
    }

    if (method === "GET") {
      return serveStaticFile(res, pathname);
    }

    res.writeHead(405, withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Method not allowed");
  } catch (error) {
    json(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  const startedAt = new Date().toISOString();
  console.log(`[${startedAt}] Weather aggregator is running on http://localhost:${PORT}`);
});

async function serveStaticFile(res, requestPath) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return json(res, 403, { error: "Forbidden path" });
  }

  let file;
  try {
    file = await fs.readFile(resolvedPath);
  } catch {
    return json(res, 404, { error: "File not found" });
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const contentType = getContentType(ext);
  res.writeHead(200, withSecurityHeaders({ "Content-Type": contentType }));
  res.end(file);
}

function getContentType(ext) {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "text/plain; charset=utf-8";
  }
}

function json(res, statusCode, payload) {
  res.writeHead(
    statusCode,
    withSecurityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    })
  );
  res.end(JSON.stringify(payload, null, 2));
}

function withSecurityHeaders(headers = {}) {
  return {
    ...SECURITY_HEADERS,
    ...headers,
  };
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  const socketAddress = req.socket && req.socket.remoteAddress;
  return socketAddress || "unknown";
}

function handleRateLimit(res, ip, scope, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${ip}`;
  const bucket = requestBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    requestBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  if (bucket.count <= limit) {
    return false;
  }

  const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  json(res, 429, {
    error: "Too many requests",
    retryAfterSec,
  });
  return true;
}

function getCityState(cityKey) {
  if (!cityStates.has(cityKey)) {
    cityStates.set(cityKey, {
      snapshot: null,
      updatedAtMs: 0,
      refreshing: null,
      clients: new Set(),
      pollTimer: null,
      cityInput: cityKey,
    });
  }
  return cityStates.get(cityKey);
}

async function refreshCity(rawCityInput, options = { force: false }) {
  const force = options.force === true;
  const cityInfo = await resolveCity(rawCityInput);
  const state = getCityState(cityInfo.cityKey);
  state.cityInput = cityInfo.cityQuery;

  if (!force && state.snapshot && Date.now() - state.updatedAtMs < STALE_AFTER_MS) {
    return state.snapshot;
  }

  if (state.refreshing) {
    return state.refreshing;
  }

  state.refreshing = (async () => {
    const snapshot = await collectSnapshot(cityInfo);
    state.snapshot = snapshot;
    state.updatedAtMs = Date.now();
    broadcastSnapshot(state, snapshot);
    return snapshot;
  })().finally(() => {
    state.refreshing = null;
  });

  return state.refreshing;
}

function openEventStream(req, res, rawCityInput) {
  resolveCity(rawCityInput)
    .then((cityInfo) => {
      const cityKey = cityInfo.cityKey;
      const state = getCityState(cityKey);
      state.cityInput = cityInfo.cityQuery;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...SECURITY_HEADERS,
      });
      res.write("retry: 4000\n\n");

      state.clients.add(res);
      startCityPolling(cityKey, state.cityInput);

      if (state.snapshot) {
        writeSseData(res, state.snapshot);
      } else {
        refreshCity(state.cityInput, { force: true }).catch((error) => {
          writeSseData(res, { error: error.message });
        });
      }

      const keepAlive = setInterval(() => {
        res.write(": ping\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        state.clients.delete(res);
        if (state.clients.size === 0) {
          stopCityPolling(cityKey);
        }
      });
    })
    .catch((error) => {
      json(res, 500, { error: error.message || "Cannot open stream" });
    });
}

function startCityPolling(cityKey, rawCityInput) {
  const state = getCityState(cityKey);
  if (state.pollTimer) {
    return;
  }

  state.pollTimer = setInterval(() => {
    refreshCity(rawCityInput, { force: true }).catch((error) => {
      console.error(`[polling:${cityKey}] ${error.message}`);
    });
  }, UPDATE_INTERVAL_MS);
}

function stopCityPolling(cityKey) {
  const state = getCityState(cityKey);
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function broadcastSnapshot(state, snapshot) {
  if (!state.clients.size) {
    return;
  }
  for (const client of state.clients) {
    writeSseData(client, snapshot);
  }
}

function writeSseData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function collectSnapshot(cityInfo) {
  const startedAt = Date.now();

  const sourcePromise = Promise.all(
    SOURCE_ORDER.map((sourceKey) => fetchSourceData(sourceKey, cityInfo))
  );
  const forecastPromise = buildCityForecast(cityInfo).catch(() => null);

  const results = await sourcePromise;

  const aggregate = buildAggregate(results);
  const forecast = (await forecastPromise) || buildSyntheticForecast(aggregate);
  const totalMs = Date.now() - startedAt;

  return {
    city: cityInfo.displayName,
    cityQuery: cityInfo.cityQuery,
    cityKey: cityInfo.cityKey,
    fetchedAt: new Date().toISOString(),
    durationMs: totalMs,
    updateIntervalMs: UPDATE_INTERVAL_MS,
    aggregate,
    sources: results,
    forecast,
  };
}

async function fetchSourceData(sourceKey, cityInfo) {
  const label = SOURCE_LABEL[sourceKey] || sourceKey;
  const fetchedAt = new Date().toISOString();

  try {
    if (sourceKey === "meteoblue") {
      return await fetchMeteoBlueSourceData(cityInfo, label, fetchedAt);
    }
    if (sourceKey === "wunderground") {
      return await fetchWeatherUndergroundSourceData(cityInfo, label, fetchedAt);
    }

    const url = await resolveSourceUrl(sourceKey, cityInfo);
    if (!url) {
      throw new Error("Cannot resolve source URL");
    }

    const html = await fetchText(url);
    const parsed = parseWeatherPayload(html, sourceKey);

    if (parsed.temperatureC === null) {
      throw new Error("Cannot parse current temperature");
    }

    return {
      source: sourceKey,
      label,
      ok: true,
      url,
      fetchedAt,
      temperatureC: roundNullable(parsed.temperatureC, 1),
      feelsLikeC: roundNullable(parsed.feelsLikeC, 1),
      humidityPct: roundNullable(parsed.humidityPct, 1),
      windKph: roundNullable(parsed.windKph, 1),
      pressureHpa: roundNullable(parsed.pressureHpa, 1),
      condition: parsed.condition,
    };
  } catch (error) {
    return {
      source: sourceKey,
      label,
      ok: false,
      url: getSourceLandingUrl(sourceKey),
      fetchedAt,
      error: error.message || "Unknown source error",
      temperatureC: null,
      feelsLikeC: null,
      humidityPct: null,
      windKph: null,
      pressureHpa: null,
      condition: null,
    };
  }
}

async function fetchMeteoBlueSourceData(cityInfo, label, fetchedAt) {
  const { lat, lon } = await resolveSourceCoordinates(cityInfo);
  const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
  endpoint.searchParams.set("latitude", String(lat));
  endpoint.searchParams.set("longitude", String(lon));
  endpoint.searchParams.set("timezone", "auto");
  endpoint.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,pressure_msl,wind_speed_10m,weather_code"
  );

  const apiUrl = endpoint.toString();
  const payload = await fetchJson(apiUrl);
  const current = payload && payload.current;
  if (!current || typeof current !== "object") {
    throw new Error("MeteoBlue response is missing current weather");
  }

  const currentUnits = payload && payload.current_units ? payload.current_units : {};
  const temperatureC = parseNumeric(current.temperature_2m);
  if (temperatureC === null) {
    throw new Error("Cannot parse current temperature");
  }

  const windRaw = parseNumeric(current.wind_speed_10m);
  const windUnit =
    typeof currentUnits.wind_speed_10m === "string" ? currentUnits.wind_speed_10m.toLowerCase() : "";
  const windKph = /m\/s/.test(windUnit) ? toKphFromMps(windRaw) : windRaw;

  return {
    source: "meteoblue",
    label,
    ok: true,
    url: getSourceLandingUrl("meteoblue"),
    fetchedAt,
    temperatureC: roundNullable(temperatureC, 1),
    feelsLikeC: roundNullable(parseNumeric(current.apparent_temperature), 1),
    humidityPct: roundNullable(parseNumeric(current.relative_humidity_2m), 1),
    windKph: roundNullable(windKph, 1),
    pressureHpa: roundNullable(parseNumeric(current.pressure_msl), 1),
    condition: mapWeatherCodeToCondition(parseNumeric(current.weather_code), temperatureC),
  };
}

async function fetchWeatherUndergroundSourceData(cityInfo, label, fetchedAt) {
  const { lat, lon } = await resolveSourceCoordinates(cityInfo);
  const endpoint = new URL("https://api.met.no/weatherapi/locationforecast/2.0/compact");
  endpoint.searchParams.set("lat", String(lat));
  endpoint.searchParams.set("lon", String(lon));

  const apiUrl = endpoint.toString();
  const payload = await fetchJson(apiUrl);
  const timeseries = payload && payload.properties && payload.properties.timeseries;
  if (!Array.isArray(timeseries) || !timeseries.length) {
    throw new Error("Weather Underground response is missing timeseries");
  }

  const point = timeseries.find((entry) => entry && entry.data && entry.data.instant && entry.data.instant.details);
  if (!point) {
    throw new Error("Weather Underground response is missing instant details");
  }

  const details = point.data.instant.details;
  const temperatureC = parseNumeric(details.air_temperature);
  if (temperatureC === null) {
    throw new Error("Cannot parse current temperature");
  }

  const symbolCode = firstFiniteString([
    point.data &&
      point.data.next_1_hours &&
      point.data.next_1_hours.summary &&
      point.data.next_1_hours.summary.symbol_code,
    point.data &&
      point.data.next_6_hours &&
      point.data.next_6_hours.summary &&
      point.data.next_6_hours.summary.symbol_code,
    point.data &&
      point.data.next_12_hours &&
      point.data.next_12_hours.summary &&
      point.data.next_12_hours.summary.symbol_code,
  ]);

  return {
    source: "wunderground",
    label,
    ok: true,
    url: getSourceLandingUrl("wunderground"),
    fetchedAt,
    temperatureC: roundNullable(temperatureC, 1),
    feelsLikeC: null,
    humidityPct: roundNullable(parseNumeric(details.relative_humidity), 1),
    windKph: roundNullable(toKphFromMps(parseNumeric(details.wind_speed)), 1),
    pressureHpa: roundNullable(parseNumeric(details.air_pressure_at_sea_level), 1),
    condition: mapMetNoSymbolToCondition(symbolCode, temperatureC),
  };
}

async function resolveSourceCoordinates(cityInfo) {
  if (Number.isFinite(cityInfo.lat) && Number.isFinite(cityInfo.lon)) {
    return {
      lat: cityInfo.lat,
      lon: cityInfo.lon,
    };
  }

  const geocoded = await geocodeCity(cityInfo.cityQuery).catch(() => null);
  if (geocoded && Number.isFinite(geocoded.lat) && Number.isFinite(geocoded.lon)) {
    return {
      lat: geocoded.lat,
      lon: geocoded.lon,
    };
  }

  throw new Error("Coordinates are unavailable for this source");
}

function getSourceLandingUrl(sourceKey) {
  if (sourceKey === "meteoblue") {
    return "https://www.meteoblue.com";
  }
  if (sourceKey === "wunderground") {
    return "https://www.wunderground.com";
  }
  return null;
}

async function resolveSourceUrl(sourceKey, cityInfo) {
  const preset = CITY_PRESETS[cityInfo.cityKey];
  if (preset && preset.urls && preset.urls[sourceKey]) {
    return preset.urls[sourceKey];
  }

  if (sourceKey === "yandex") {
    if (cityInfo.lat !== null && cityInfo.lon !== null) {
      return `https://yandex.ru/pogoda/?lat=${cityInfo.lat}&lon=${cityInfo.lon}`;
    }
    return `https://yandex.ru/pogoda/${cityInfo.cityKey}`;
  }

  if (sourceKey === "weathercom") {
    if (cityInfo.lat !== null && cityInfo.lon !== null) {
      return `https://weather.com/weather/today/l/${cityInfo.lat},${cityInfo.lon}`;
    }
    return "https://weather.com/weather/today";
  }

  if (sourceKey === "gismeteo") {
    return resolveGismeteoUrl(cityInfo.cityQuery);
  }

  if (sourceKey === "meteoinfo") {
    return resolveMeteoinfoUrl(cityInfo.cityQuery);
  }

  return null;
}

async function resolveGismeteoUrl(cityQuery) {
  const searchUrl = `https://www.gismeteo.ru/search/${encodeURIComponent(cityQuery)}/`;
  const html = await fetchText(searchUrl);

  const absolute = findFirstAbsoluteLink(html, [
    /href="(https?:\/\/www\.gismeteo\.ru\/weather-[^"?#]+\/)"/i,
    /href="(https?:\/\/gismeteo\.ru\/weather-[^"?#]+\/)"/i,
  ]);
  if (absolute) {
    return absolute;
  }

  const relative = findFirstRelativeLink(html, [/href="(\/weather-[^"?#]+\/)"/i], "https://www.gismeteo.ru");
  if (relative) {
    return relative;
  }

  return searchUrl;
}

async function resolveMeteoinfoUrl(cityQuery) {
  const searchUrl = `https://meteoinfo.ru/search?searchword=${encodeURIComponent(cityQuery)}`;
  const html = await fetchText(searchUrl);

  const absolute = findFirstAbsoluteLink(html, [
    /href="(https?:\/\/(?:www\.)?meteoinfo\.ru\/pogoda\/[^"?#]+)"/i,
    /href="(https?:\/\/(?:www\.)?meteoinfo\.ru\/prognoz\/[^"?#]+)"/i,
  ]);
  if (absolute) {
    return absolute;
  }

  const relative = findFirstRelativeLink(
    html,
    [/href="(\/pogoda\/[^"?#]+)"/i, /href="(\/prognoz\/[^"?#]+)"/i],
    "https://meteoinfo.ru"
  );
  if (relative) {
    return relative;
  }

  return searchUrl;
}

function findFirstAbsoluteLink(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

function findFirstRelativeLink(html, patterns, baseUrl) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      try {
        return new URL(match[1], baseUrl).href;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

async function resolveCity(rawInput) {
  const cityQuery = sanitizeCityQuery(rawInput);
  const cityKey = normalizeCityKey(cityQuery);
  const preset = CITY_PRESETS[cityKey];

  if (preset) {
    return {
      cityQuery,
      cityKey,
      displayName: preset.displayName,
      lat: preset.lat,
      lon: preset.lon,
    };
  }

  const geocoded = await geocodeCity(cityQuery).catch(() => null);
  if (geocoded) {
    return {
      cityQuery,
      cityKey,
      displayName: `${geocoded.name}${geocoded.country ? `, ${geocoded.country}` : ""}`,
      lat: geocoded.lat,
      lon: geocoded.lon,
    };
  }

  return {
    cityQuery,
    cityKey,
    displayName: titleCase(cityQuery),
    lat: null,
    lon: null,
  };
}

function sanitizeCityQuery(value) {
  const cleaned = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "Москва";
  }
  return cleaned.slice(0, 80);
}

function normalizeCityKey(input) {
  const trimmed = String(input || "").trim().toLowerCase();
  const alias = CITY_ALIASES[trimmed] || trimmed;
  const latin = transliterate(alias);
  const slug = latin
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "moscow";
}

function transliterate(input) {
  const map = {
    "\u0430": "a",
    "\u0431": "b",
    "\u0432": "v",
    "\u0433": "g",
    "\u0434": "d",
    "\u0435": "e",
    "\u0451": "e",
    "\u0436": "zh",
    "\u0437": "z",
    "\u0438": "i",
    "\u0439": "y",
    "\u043a": "k",
    "\u043b": "l",
    "\u043c": "m",
    "\u043d": "n",
    "\u043e": "o",
    "\u043f": "p",
    "\u0440": "r",
    "\u0441": "s",
    "\u0442": "t",
    "\u0443": "u",
    "\u0444": "f",
    "\u0445": "h",
    "\u0446": "ts",
    "\u0447": "ch",
    "\u0448": "sh",
    "\u0449": "sch",
    "\u044a": "",
    "\u044b": "y",
    "\u044c": "",
    "\u044d": "e",
    "\u044e": "yu",
    "\u044f": "ya",
  };
  return input
    .toLowerCase()
    .split("")
    .map((char) => map[char] || char)
    .join("");
}

function titleCase(input) {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => chunk[0].toUpperCase() + chunk.slice(1).toLowerCase())
    .join(" ");
}

async function geocodeCity(city) {
  const endpoint = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
    city
  )}&count=1&language=ru&format=json`;
  const data = await fetchJson(endpoint);
  const hit = data && data.results && data.results[0];
  if (!hit) {
    return null;
  }
  return {
    name: hit.name || city,
    country: hit.country_code || null,
    lat: hit.latitude,
    lon: hit.longitude,
  };
}

async function buildCityForecast(cityInfo) {
  if (!Number.isFinite(cityInfo.lat) || !Number.isFinite(cityInfo.lon)) {
    return null;
  }

  const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
  endpoint.searchParams.set("latitude", String(cityInfo.lat));
  endpoint.searchParams.set("longitude", String(cityInfo.lon));
  endpoint.searchParams.set("timezone", "auto");
  endpoint.searchParams.set("forecast_days", "7");
  endpoint.searchParams.set(
    "hourly",
    "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m"
  );
  endpoint.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max"
  );

  const payload = await fetchJson(endpoint.toString());
  const forecast = normalizeOpenMeteoForecast(payload);
  return forecast;
}

function normalizeOpenMeteoForecast(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const hourlyNode = payload.hourly || {};
  const hourlyTimes = Array.isArray(hourlyNode.time) ? hourlyNode.time : [];
  const hourly = [];

  for (let index = 0; index < hourlyTimes.length; index += 1) {
    const time = String(hourlyTimes[index] || "");
    if (!time) {
      continue;
    }

    const tempC = parseNumeric(hourlyNode.temperature_2m && hourlyNode.temperature_2m[index]);
    const code = parseNumeric(
      (hourlyNode.weather_code && hourlyNode.weather_code[index]) ||
        (hourlyNode.weathercode && hourlyNode.weathercode[index])
    );
    const chanceRaw = parseNumeric(
      (hourlyNode.precipitation_probability && hourlyNode.precipitation_probability[index]) ||
        (hourlyNode.precipitationProbability && hourlyNode.precipitationProbability[index])
    );
    const precipRaw = parseNumeric(
      (hourlyNode.precipitation && hourlyNode.precipitation[index]) ||
        (hourlyNode.rain && hourlyNode.rain[index])
    );
    const windRaw = parseNumeric(
      (hourlyNode.wind_speed_10m && hourlyNode.wind_speed_10m[index]) ||
        (hourlyNode.windspeed_10m && hourlyNode.windspeed_10m[index])
    );

    const date = time.slice(0, 10);
    const hour = parseIsoHour(time);
    hourly.push({
      time,
      date,
      hour,
      tempC: roundNullable(tempC, 1),
      condition: mapWeatherCodeToCondition(code, tempC),
      precipChancePct: chanceRaw === null ? null : Math.round(clampNumber(chanceRaw, 0, 100)),
      precipMm: roundNullable(clampNumber(precipRaw === null ? 0 : precipRaw, 0, 999), 1),
      windKph: roundNullable(clampNumber(windRaw === null ? 0 : windRaw, 0, 220), 1),
    });
  }

  const dailyNode = payload.daily || {};
  const dailyTimes = Array.isArray(dailyNode.time) ? dailyNode.time.slice(0, 7) : [];
  const daily = dailyTimes.map((date, index) => {
    const tempMinC = parseNumeric(dailyNode.temperature_2m_min && dailyNode.temperature_2m_min[index]);
    const tempMaxC = parseNumeric(dailyNode.temperature_2m_max && dailyNode.temperature_2m_max[index]);
    const chanceRaw = parseNumeric(
      (dailyNode.precipitation_probability_max && dailyNode.precipitation_probability_max[index]) ||
        (dailyNode.precipitation_probability_mean && dailyNode.precipitation_probability_mean[index])
    );
    const precipRaw = parseNumeric(dailyNode.precipitation_sum && dailyNode.precipitation_sum[index]);
    const code = parseNumeric(
      (dailyNode.weather_code && dailyNode.weather_code[index]) ||
        (dailyNode.weathercode && dailyNode.weathercode[index])
    );

    const dayHours = hourly.filter((row) => row.date === date);
    const periods = buildForecastPeriodsForDay(date, dayHours, {
      tempMinC,
      tempMaxC,
      condition: mapWeatherCodeToCondition(code, tempMaxC),
      chancePct: chanceRaw,
    });

    const maxFromHours = maxFinite(dayHours.map((row) => row.precipChancePct));
    const precipChancePct = roundNullable(
      clampNumber(
        chanceRaw === null ? maxFromHours === null ? 0 : maxFromHours : chanceRaw,
        0,
        100
      ),
      0
    );
    const sumFromHours = roundNullable(sumFinite(dayHours.map((row) => row.precipMm)), 1);
    const precipMm = roundNullable(
      precipRaw === null ? (sumFromHours === null ? 0 : sumFromHours) : precipRaw,
      1
    );

    return {
      date,
      tempMinC: roundNullable(tempMinC, 1),
      tempMaxC: roundNullable(tempMaxC, 1),
      condition: mapWeatherCodeToCondition(code, tempMaxC) || deriveConditionFromChance(precipChancePct, tempMaxC),
      precipChancePct,
      precipMm,
      periods,
    };
  });

  if (!daily.length || !hourly.length) {
    return null;
  }

  return {
    provider: "open-meteo",
    timezone: typeof payload.timezone === "string" ? payload.timezone : "auto",
    generatedAt: new Date().toISOString(),
    daily,
    hourly,
  };
}

function buildForecastPeriodsForDay(date, hourlyRows, dayFallback) {
  const rows = Array.isArray(hourlyRows) ? hourlyRows : [];
  const anchors = [
    { key: "night", hour: 0 },
    { key: "morning", hour: 9 },
    { key: "day", hour: 14 },
    { key: "evening", hour: 19 },
  ];

  return anchors.map((anchor) => {
    const nearest = selectNearestHourEntry(rows, anchor.hour);

    if (!nearest) {
      const blendedTemp = estimatePeriodTemperature(anchor.key, dayFallback.tempMinC, dayFallback.tempMaxC);
      return {
        key: anchor.key,
        hour: anchor.hour,
        tempC: roundNullable(blendedTemp, 1),
        condition: dayFallback.condition || deriveConditionFromChance(dayFallback.chancePct, blendedTemp),
        precipChancePct:
          dayFallback.chancePct === null || dayFallback.chancePct === undefined
            ? null
            : Math.round(clampNumber(dayFallback.chancePct, 0, 100)),
        precipMm: null,
        windKph: null,
      };
    }

    return {
      key: anchor.key,
      hour: anchor.hour,
      tempC: roundNullable(nearest.tempC, 1),
      condition: nearest.condition || dayFallback.condition || "Cloudy",
      precipChancePct:
        nearest.precipChancePct === null || nearest.precipChancePct === undefined
          ? null
          : Math.round(clampNumber(nearest.precipChancePct, 0, 100)),
      precipMm: nearest.precipMm,
      windKph: nearest.windKph,
    };
  });
}

function selectNearestHourEntry(rows, targetHour) {
  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  let winner = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const hour = Number.isFinite(row.hour) ? row.hour : parseIsoHour(row.time);
    if (!Number.isFinite(hour)) {
      continue;
    }
    const distance = Math.abs(hour - targetHour);
    if (distance < bestDistance) {
      winner = row;
      bestDistance = distance;
    }
  }
  return winner;
}

function estimatePeriodTemperature(periodKey, tempMinC, tempMaxC) {
  if (!Number.isFinite(tempMinC) && !Number.isFinite(tempMaxC)) {
    return null;
  }
  if (!Number.isFinite(tempMinC)) {
    return tempMaxC;
  }
  if (!Number.isFinite(tempMaxC)) {
    return tempMinC;
  }

  if (periodKey === "night") {
    return tempMinC;
  }
  if (periodKey === "morning") {
    return tempMinC + (tempMaxC - tempMinC) * 0.35;
  }
  if (periodKey === "day") {
    return tempMaxC;
  }
  return tempMinC + (tempMaxC - tempMinC) * 0.52;
}

function buildSyntheticForecast(aggregate) {
  const now = new Date();
  now.setMinutes(0, 0, 0);

  const baseTemp = Number.isFinite(aggregate.temperatureC) ? aggregate.temperatureC : 8;
  const baseChance = inferChanceFromAggregate(aggregate);
  const baseWind = Number.isFinite(aggregate.windKph) ? aggregate.windKph : 14;
  const hourly = [];
  const daily = [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayStart = new Date(now);
    dayStart.setDate(now.getDate() + dayIndex);
    dayStart.setHours(0, 0, 0, 0);
    const dayDate = formatLocalDateKey(dayStart);
    const dayRows = [];

    for (let hour = 0; hour < 24; hour += 1) {
      const point = new Date(dayStart);
      point.setHours(hour, 0, 0, 0);

      const diurnal = Math.cos((Math.PI * (hour - 14)) / 12);
      const dayDrift = Math.sin((dayIndex + 1) * 0.9) * 2 + Math.cos((dayIndex + 2) * 0.35);
      const tempC = roundNullable(baseTemp + dayDrift + diurnal * 4.2, 1);

      const wave = Math.sin((hour + dayIndex * 3) / 3.2) * 16;
      const chancePct = Math.round(clampNumber(baseChance + wave - dayIndex * 1.2, 5, 95));
      const condition = deriveConditionFromChance(chancePct, tempC);
      const precipMm = chancePct >= 40 ? roundNullable((chancePct / 100) * (condition === "Rain" ? 1.6 : 1), 1) : 0;
      const windKph = roundNullable(clampNumber(baseWind + Math.sin((hour + dayIndex) / 4) * 4, 0, 160), 1);

      const row = {
        time: formatLocalHourKey(point),
        date: dayDate,
        hour,
        tempC,
        condition,
        precipChancePct: chancePct,
        precipMm,
        windKph,
      };
      dayRows.push(row);
      hourly.push(row);
    }

    const tempMinC = minFinite(dayRows.map((row) => row.tempC));
    const tempMaxC = maxFinite(dayRows.map((row) => row.tempC));
    const precipChancePct = maxFinite(dayRows.map((row) => row.precipChancePct));
    const precipMm = roundNullable(sumFinite(dayRows.map((row) => row.precipMm)), 1);
    const midday = selectNearestHourEntry(dayRows, 14);

    daily.push({
      date: dayDate,
      tempMinC: roundNullable(tempMinC, 1),
      tempMaxC: roundNullable(tempMaxC, 1),
      condition: (midday && midday.condition) || deriveConditionFromChance(precipChancePct, tempMaxC),
      precipChancePct: precipChancePct === null ? null : Math.round(clampNumber(precipChancePct, 0, 100)),
      precipMm,
      periods: buildForecastPeriodsForDay(dayDate, dayRows, {
        tempMinC,
        tempMaxC,
        condition: (midday && midday.condition) || aggregate.condition || "Cloudy",
        chancePct: precipChancePct,
      }),
    });
  }

  return {
    provider: "synthetic",
    timezone: "local",
    generatedAt: new Date().toISOString(),
    daily,
    hourly,
  };
}

function deriveConditionFromChance(chancePct, tempC) {
  const chance = Number.isFinite(chancePct) ? chancePct : 0;
  if (chance >= 80) {
    return Number.isFinite(tempC) && tempC <= 0 ? "Snow" : "Rain";
  }
  if (chance >= 55) {
    return Number.isFinite(tempC) && tempC <= -2 ? "Snow" : "Cloudy";
  }
  if (chance >= 35) {
    return "Cloudy";
  }
  return "Clear";
}

function inferChanceFromAggregate(aggregate) {
  const humidity = Number.isFinite(aggregate.humidityPct) ? aggregate.humidityPct : 55;
  const condition = String(aggregate.condition || "").toLowerCase();

  let conditionBoost = 0;
  if (/thunder|storm/.test(condition)) {
    conditionBoost = 35;
  } else if (/snow/.test(condition)) {
    conditionBoost = 26;
  } else if (/rain|drizzle|shower/.test(condition)) {
    conditionBoost = 30;
  } else if (/fog|mist/.test(condition)) {
    conditionBoost = 15;
  } else if (/cloud/.test(condition)) {
    conditionBoost = 8;
  }

  return Math.round(clampNumber((humidity - 30) * 0.85 + conditionBoost, 6, 92));
}

function mapWeatherCodeToCondition(code, temperatureC) {
  if (!Number.isFinite(code)) {
    return null;
  }

  if (code === 0) {
    return "Clear";
  }
  if (code === 1 || code === 2 || code === 3) {
    return "Cloudy";
  }
  if (code === 45 || code === 48) {
    return "Fog";
  }
  if ([51, 53, 55, 56, 57].includes(code)) {
    return Number.isFinite(temperatureC) && temperatureC <= 0 ? "Snow" : "Rain";
  }
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) {
    return Number.isFinite(temperatureC) && temperatureC <= -1 ? "Snow" : "Rain";
  }
  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return "Snow";
  }
  if ([95, 96, 99].includes(code)) {
    return "Thunderstorm";
  }
  return "Cloudy";
}

function mapMetNoSymbolToCondition(symbolCode, temperatureC) {
  if (!symbolCode) {
    return null;
  }
  const normalized = String(symbolCode).toLowerCase();

  if (/thunder/.test(normalized)) {
    return "Thunderstorm";
  }
  if (/(snow|sleet)/.test(normalized)) {
    return "Snow";
  }
  if (/(rain|drizzle|shower)/.test(normalized)) {
    return Number.isFinite(temperatureC) && temperatureC <= -1 ? "Snow" : "Rain";
  }
  if (/(fog|mist|haze)/.test(normalized)) {
    return "Fog";
  }
  if (/(cloud|overcast|partlycloudy)/.test(normalized)) {
    return "Cloudy";
  }
  if (/(clear|fair|sun)/.test(normalized)) {
    return "Clear";
  }

  return normalizeCondition(normalized.replace(/_/g, " "));
}

function parseIsoHour(value) {
  const text = String(value || "");
  const direct = text.match(/T(\d{2})/);
  if (direct) {
    const hour = Number(direct[1]);
    if (Number.isFinite(hour)) {
      return hour;
    }
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.getHours();
}

function formatLocalDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "1970-01-01";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalHourKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "1970-01-01T00:00";
  }
  const hour = String(date.getHours()).padStart(2, "0");
  return `${formatLocalDateKey(date)}T${hour}:00`;
}

function minFinite(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return null;
  }
  return Math.min(...numeric);
}

function maxFinite(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return null;
  }
  return Math.max(...numeric);
}

function sumFinite(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return null;
  }
  return numeric.reduce((acc, value) => acc + value, 0);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseWeatherPayload(html, sourceKey) {
  const generic = parseGenericPayload(html, sourceKey);
  const sourceSpecific = parseSourceSpecificPayload(html, sourceKey);
  return mergeParsed(sourceSpecific, generic);
}

function parseSourceSpecificPayload(html, sourceKey) {
  if (sourceKey === "gismeteo") {
    return parseGismeteoPayload(html);
  }
  if (sourceKey === "meteoinfo") {
    return parseMeteoinfoPayload(html);
  }
  if (sourceKey === "weathercom") {
    return parseWeatherComPayload(html);
  }
  return emptyParsed();
}

function parseGenericPayload(html, sourceKey) {
  const sections = extractSignalSections(html);
  const joined = sections.join(" ");
  const cleaned = normalizeText(joined);

  return {
    temperatureC: extractTemperature(cleaned),
    feelsLikeC: extractFeelsLike(cleaned),
    humidityPct: extractHumidity(cleaned),
    windKph: extractWind(cleaned, sourceKey),
    pressureHpa: extractPressure(cleaned),
    condition: extractCondition(cleaned),
  };
}

function parseGismeteoPayload(html) {
  const stateObjectText = extractJsonObjectAfterToken(html, "window.M.state =");
  const state = safeJsonParse(stateObjectText);
  const cw = state && state.weather && state.weather.cw;

  if (!cw || typeof cw !== "object") {
    return emptyParsed();
  }

  const description = firstInArray(cw.description);
  return {
    temperatureC: parseNumeric(firstInArray(cw.temperatureAir)),
    feelsLikeC: parseNumeric(firstInArray(cw.temperatureFeelsLike)),
    humidityPct: parseNumeric(firstInArray(cw.humidity)),
    windKph: toKphFromMps(parseNumeric(firstInArray(cw.windSpeed))),
    pressureHpa: toHpaFromMmHg(parseNumeric(firstInArray(cw.pressure))),
    condition: normalizeCondition(description),
  };
}

function parseMeteoinfoPayload(html) {
  const rowRe = /<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let match;

  let temperatureC = null;
  let feelsLikeC = null;
  let humidityPct = null;
  let windKph = null;
  let pressureHpa = null;
  let condition = null;

  while ((match = rowRe.exec(html)) !== null) {
    const left = normalizeText(match[1]).toLowerCase();
    const right = normalizeText(match[2]);
    if (!left && !right) {
      continue;
    }

    if (left.includes("\u0442\u0435\u043c\u043f\u0435\u0440\u0430\u0442\u0443\u0440")) {
      const value = parseNumeric(right);
      if (value !== null) {
        temperatureC = value;
      }
    }

    if (left.includes("\u0432\u043b\u0430\u0436\u043d")) {
      const value = parseNumeric(right);
      if (value !== null) {
        humidityPct = value;
      }
    }

    if (left.includes("\u0434\u0430\u0432\u043b\u0435\u043d")) {
      const value = parseNumeric(right);
      if (value !== null) {
        pressureHpa = toHpaFromMmHg(value);
      }
    }

    if (/\u0432\u0435\u0442\u0440/.test(left)) {
      const value = parseNumeric(right);
      if (value !== null) {
        windKph = toKphFromMps(value);
      }
    }

    if (!left && /[A-Za-z\u0400-\u04FF]/.test(right) && !/\d/.test(right)) {
      condition = normalizeCondition(right);
    }
  }

  if (!condition) {
    const conditionMatch = html.match(
      /<img[^>]*>\s*<\/td>\s*<\/tr>\s*<tr>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/i
    );
    if (conditionMatch && conditionMatch[1]) {
      condition = normalizeCondition(conditionMatch[1]);
    }
  }

  return {
    temperatureC,
    feelsLikeC,
    humidityPct,
    windKph,
    pressureHpa,
    condition,
  };
}

function parseWeatherComPayload(html) {
  const token = '"observation":';
  const index = html.indexOf(token);
  if (index === -1) {
    return emptyParsed();
  }

  const observationObjectText = extractJsonObjectAfterToken(html, token);
  const observation = safeJsonParse(observationObjectText);
  if (!observation || typeof observation !== "object") {
    return emptyParsed();
  }

  const localContext = html
    .slice(Math.max(0, index - 9000), Math.min(html.length, index + 9000))
    .toLowerCase();
  const pressureAltimeter = parseNumeric(observation.pressureAltimeter);
  const usesImperial =
    /units:e/.test(localContext) ||
    (Number.isFinite(pressureAltimeter) && pressureAltimeter > 10 && pressureAltimeter < 40);

  let temperatureC = parseNumeric(observation.temperature);
  if (temperatureC !== null && (usesImperial || temperatureC > 60)) {
    temperatureC = fahrenheitToCelsius(temperatureC);
  }

  let feelsLikeC = parseNumeric(observation.temperatureFeelsLike);
  if (feelsLikeC !== null && (usesImperial || feelsLikeC > 60)) {
    feelsLikeC = fahrenheitToCelsius(feelsLikeC);
  }

  const humidityPct = firstFinite([
    parseNumeric(observation.relativeHumidity),
    parseNumeric(observation.humidity),
  ]);

  let windKph = firstFinite([
    parseNumeric(observation.windSpeed),
    parseNumeric(observation.windSpeedMph),
    parseNumeric(observation.windSpeedKph),
  ]);
  if (windKph !== null && (usesImperial || observation.windSpeedMph !== undefined)) {
    windKph *= 1.60934;
  }

  const pressureHpa = firstFinite([
    parseNumeric(observation.pressureMeanSeaLevel),
    toHpaFromInHg(pressureAltimeter),
    parseNumeric(observation.pressure),
  ]);

  const condition = normalizeCondition(
    firstFiniteString([
      observation.wxPhraseLong,
      observation.wxPhraseMedium,
      observation.wxPhraseShort,
      observation.cloudCoverPhrase,
    ])
  );

  return {
    temperatureC,
    feelsLikeC,
    humidityPct,
    windKph,
    pressureHpa,
    condition,
  };
}

function mergeParsed(primary, fallback) {
  const result = emptyParsed();
  const main = primary || {};
  const alt = fallback || {};

  result.temperatureC = firstFinite([main.temperatureC, alt.temperatureC]);
  result.feelsLikeC = firstFinite([main.feelsLikeC, alt.feelsLikeC]);
  result.humidityPct = firstFinite([main.humidityPct, alt.humidityPct]);
  result.windKph = firstFinite([main.windKph, alt.windKph]);
  result.pressureHpa = firstFinite([main.pressureHpa, alt.pressureHpa]);
  result.condition = main.condition || alt.condition || null;

  return result;
}

function emptyParsed() {
  return {
    temperatureC: null,
    feelsLikeC: null,
    humidityPct: null,
    windKph: null,
    pressureHpa: null,
    condition: null,
  };
}

function extractSignalSections(html) {
  const sections = [];

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    sections.push(titleMatch[1]);
  }

  const metaRe =
    /<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(metaRe)) {
    if (match[1]) {
      sections.push(match[1]);
    }
  }

  const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const body = match[1] || "";
    if (!body) {
      continue;
    }
    if (!/(temp|temperature|weather|humidity|pressure|wind|погод|температур|влажност|давлен|ветер)/i.test(body)) {
      continue;
    }
    if (body.length <= 50000) {
      sections.push(body);
    } else {
      sections.push(body.slice(0, 25000));
    }
  }

  const textBody = normalizeText(html);
  sections.push(textBody.slice(0, 90000));

  return sections;
}

function normalizeText(input) {
  return decodeHtmlEntities(
    stripTags(input)
      .replace(/\\u00b0/gi, "°")
      .replace(/\\u2212/gi, "-")
      .replace(/\\n|\\r|\\t/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function stripTags(input) {
  return String(input)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtmlEntities(input) {
  return String(input)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&deg;|&#176;|&#xB0;/gi, "°")
    .replace(/&minus;|&#8722;/gi, "-")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractTemperature(text) {
  const candidates = [];
  const degreeRe = /(-?\d{1,3}(?:[.,]\d+)?)\s*(?:°|º)\s*([cCfF\u0441\u0421\u0444\u0424]?)/g;
  const keyRe =
    /"(?:temp|temperature|temp_c|air_temperature|current_temp|fact_temp)"\s*[:=]\s*"?(?<value>-?\d{1,3}(?:[.,]\d+)?)"?/gi;

  pushNumericMatches(candidates, text, degreeRe, (match, context) => {
    const raw = parseNumeric(match[1]);
    if (raw === null) {
      return null;
    }
    const unit = (match[2] || "c").toLowerCase();
    const celsius = unit === "f" || unit === "\u0444" ? fahrenheitToCelsius(raw) : raw;
    return scoreNumeric(celsius, context, ["current", "now", "currently", "\u0441\u0435\u0439\u0447\u0430\u0441", "\u0442\u0435\u043a\u0443\u0449"], ["low", "high", "min", "max", "\u043c\u0438\u043d", "\u043c\u0430\u043a\u0441"]);
  });

  pushNamedNumericMatches(candidates, text, keyRe, (value, context) => {
    return scoreNumeric(value, context, ["temp", "temperature", "\u0442\u0435\u043c\u043f\u0435\u0440"], ["forecast", "day", "night"]);
  });

  const picked = pickBestCandidate(candidates, (value) => value >= -90 && value <= 65);
  return picked === null ? null : round1(picked);
}

function extractFeelsLike(text) {
  const candidates = [];
  const explicitRe =
    /(?:feels[\s-]?like|realfeel|apparent|\u043e\u0449\u0443\u0449\u0430\u0435\u0442\u0441\u044f(?:\s+\u043a\u0430\u043a)?)\D{0,25}(-?\d{1,3}(?:[.,]\d+)?)\s*(?:°|º)?\s*([cCfF\u0441\u0421\u0444\u0424]?)/gi;
  const keyRe = /"(?:feels_like|apparent_temperature)"\s*[:=]\s*"?(?<value>-?\d{1,3}(?:[.,]\d+)?)"?/gi;

  pushNumericMatches(candidates, text, explicitRe, (match, context) => {
    const raw = parseNumeric(match[1]);
    if (raw === null) {
      return null;
    }
    const unit = (match[2] || "c").toLowerCase();
    const celsius = unit === "f" || unit === "\u0444" ? fahrenheitToCelsius(raw) : raw;
    return scoreNumeric(celsius, context, ["feels", "realfeel", "apparent", "\u043e\u0449\u0443\u0449"], ["min", "max"]);
  });

  pushNamedNumericMatches(candidates, text, keyRe, (value, context) => {
    return scoreNumeric(value, context, ["feels_like", "apparent"], []);
  });

  const picked = pickBestCandidate(candidates, (value) => value >= -90 && value <= 65);
  return picked === null ? null : round1(picked);
}

function extractHumidity(text) {
  const candidates = [];
  const percentRe = /(?:humidity|\u0432\u043b\u0430\u0436\u043d\u043e\u0441\u0442[\u044c\u0438]?|"humidity")\D{0,20}(\d{1,3})\s*%?/gi;

  pushNumericMatches(candidates, text, percentRe, (match, context) => {
    const value = parseNumeric(match[1]);
    if (value === null) {
      return null;
    }
    return scoreNumeric(value, context, ["humidity", "\u0432\u043b\u0430\u0436"], []);
  });

  const picked = pickBestCandidate(candidates, (value) => value >= 0 && value <= 100);
  return picked === null ? null : Math.round(picked);
}

function extractWind(text, sourceKey) {
  const candidates = [];
  const windRe =
    /(?:wind(?:\s*speed)?|wind_speed|\u0432\u0435\u0442\u0435\u0440)\D{0,25}(-?\d{1,3}(?:[.,]\d+)?)\s*(km\/h|kph|m\/s|mph|\u043c\/\u0441|\u043a\u043c\/\u0447)?/gi;

  pushNumericMatches(candidates, text, windRe, (match, context) => {
    const raw = parseNumeric(match[1]);
    if (raw === null) {
      return null;
    }
    const unit = (match[2] || "").toLowerCase();
    let kph = raw;

    if (unit === "m/s" || unit === "\u043c/\u0441") {
      kph = raw * 3.6;
    } else if (unit === "mph") {
      kph = raw * 1.60934;
    } else if (!unit && sourceKey === "yandex") {
      kph = raw * 3.6;
    }

    return scoreNumeric(kph, context, ["wind", "\u0432\u0435\u0442\u0435\u0440"], []);
  });

  const picked = pickBestCandidate(candidates, (value) => value >= 0 && value <= 200);
  return picked === null ? null : round1(picked);
}

function extractPressure(text) {
  const candidates = [];
  const pressureRe =
    /(?:pressure_mm|pressure|\u0434\u0430\u0432\u043b\u0435\u043d[\u0438\u0435\u044f])\D{0,20}(\d{2,4})(?:\s*(hpa|mb|mbar|mmhg|\u043c\u043c(?:\s*\u0440\u0442)?))?/gi;

  pushNumericMatches(candidates, text, pressureRe, (match, context) => {
    const raw = parseNumeric(match[1]);
    if (raw === null) {
      return null;
    }

    const unit = (match[2] || "").toLowerCase();
    let hpa = raw;

    if (unit.includes("mm")) {
      hpa = raw * 1.33322;
    } else if (unit.includes("hpa") || unit.includes("mb")) {
      hpa = raw;
    } else if (/pressure_mm/i.test(context) || (raw >= 680 && raw <= 820)) {
      hpa = raw * 1.33322;
    } else if (raw >= 850 && raw <= 1200) {
      hpa = raw;
    }

    return scoreNumeric(hpa, context, ["pressure", "\u0434\u0430\u0432\u043b"], []);
  });

  const picked = pickBestCandidate(candidates, (value) => value >= 850 && value <= 1100);
  return picked === null ? null : Math.round(picked);
}

function extractCondition(text) {
  const rules = [
    { regex: /(thunder|storm|\u0433\u0440\u043e\u0437)/i, label: "Thunderstorm" },
    { regex: /(snow|sleet|blizzard|\u0441\u043d\u0435\u0433|\u043c\u0435\u0442\u0435\u043b)/i, label: "Snow" },
    { regex: /(rain|drizzle|shower|\u0434\u043e\u0436\u0434)/i, label: "Rain" },
    { regex: /(fog|mist|haze|\u0442\u0443\u043c\u0430\u043d)/i, label: "Fog" },
    { regex: /(overcast|\u043f\u0430\u0441\u043c\u0443\u0440\u043d|cloudy|\u043e\u0431\u043b\u0430\u0447)/i, label: "Cloudy" },
    { regex: /(clear|sunny|\u044f\u0441\u043d\u043e|\u0441\u043e\u043b\u043d)/i, label: "Clear" },
  ];

  for (const rule of rules) {
    if (rule.regex.test(text)) {
      return rule.label;
    }
  }
  return null;
}

function extractJsonObjectAfterToken(input, token) {
  if (!input || !token) {
    return null;
  }

  const tokenIndex = input.indexOf(token);
  if (tokenIndex === -1) {
    return null;
  }

  const startIndex = input.indexOf("{", tokenIndex + token.length);
  if (startIndex === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function safeJsonParse(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstInArray(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function firstFinite(values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function firstFiniteString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function toKphFromMps(mps) {
  if (!Number.isFinite(mps)) {
    return null;
  }
  return mps * 3.6;
}

function toHpaFromMmHg(mmHg) {
  if (!Number.isFinite(mmHg)) {
    return null;
  }
  return mmHg * 1.33322;
}

function toHpaFromInHg(inHg) {
  if (!Number.isFinite(inHg)) {
    return null;
  }
  return inHg * 33.8638866667;
}

function normalizeCondition(raw) {
  if (!raw) {
    return null;
  }
  const clean = normalizeText(String(raw));
  if (!clean) {
    return null;
  }
  return extractCondition(clean) || clean.slice(0, 80);
}

function pushNumericMatches(storage, text, regex, scorer) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const context = sliceContext(text, match.index, 60);
    const scored = scorer(match, context);
    if (!scored) {
      continue;
    }
    storage.push(scored);
  }
}

function pushNamedNumericMatches(storage, text, regex, scorer) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = parseNumeric(match.groups && match.groups.value);
    if (value === null) {
      continue;
    }
    const context = sliceContext(text, match.index, 60);
    const scored = scorer(value, context);
    if (!scored) {
      continue;
    }
    storage.push(scored);
  }
}

function sliceContext(text, index, size) {
  const start = Math.max(0, index - size);
  const end = Math.min(text.length, index + size);
  return text.slice(start, end).toLowerCase();
}

function scoreNumeric(value, context, positiveHints, negativeHints) {
  if (!Number.isFinite(value)) {
    return null;
  }
  let score = 0;

  for (const hint of positiveHints) {
    if (context.includes(hint.toLowerCase())) {
      score += 3;
    }
  }
  for (const hint of negativeHints) {
    if (context.includes(hint.toLowerCase())) {
      score -= 2;
    }
  }

  score += 1;
  return { value, score };
}

function pickBestCandidate(candidates, validator) {
  if (!candidates.length) {
    return null;
  }
  const filtered = candidates.filter((candidate) => validator(candidate.value));
  if (!filtered.length) {
    return null;
  }
  filtered.sort((a, b) => b.score - a.score);
  return filtered[0].value;
}

function parseNumeric(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  const normalized = String(raw).replace(",", ".").replace(/\s+/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function roundNullable(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const power = 10 ** digits;
  return Math.round(value * power) / power;
}

function fahrenheitToCelsius(f) {
  return (f - 32) * (5 / 9);
}

function buildAggregate(sourceRows) {
  const ok = sourceRows.filter((row) => row.ok);
  const temperatureC = average(ok.map((row) => row.temperatureC), { tolerance: 15 });
  const feelsLikeC = average(ok.map((row) => row.feelsLikeC), { tolerance: 15 });
  const humidityPct = average(ok.map((row) => row.humidityPct));
  const windKph = average(ok.map((row) => row.windKph), { tolerance: 45 });
  const pressureHpa = average(ok.map((row) => row.pressureHpa), { tolerance: 35 });
  const condition = summarizeCondition(ok.map((row) => row.condition));

  return {
    sourceCount: ok.length,
    expectedSourceCount: SOURCE_ORDER.length,
    confidencePct: Math.round((ok.length / SOURCE_ORDER.length) * 100),
    temperatureC: temperatureC === null ? null : round1(temperatureC),
    feelsLikeC: feelsLikeC === null ? null : round1(feelsLikeC),
    humidityPct: humidityPct === null ? null : Math.round(humidityPct),
    windKph: windKph === null ? null : round1(windKph),
    pressureHpa: pressureHpa === null ? null : Math.round(pressureHpa),
    condition,
  };
}

function average(values, options = {}) {
  const tolerance = Number.isFinite(options.tolerance) ? Number(options.tolerance) : null;
  let numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return null;
  }

  if (tolerance !== null && numeric.length >= 3) {
    const sorted = [...numeric].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];

    const filtered = numeric.filter((value) => Math.abs(value - median) <= tolerance);
    if (filtered.length >= Math.max(2, Math.ceil(numeric.length / 2))) {
      numeric = filtered;
    }
  }

  const sum = numeric.reduce((acc, value) => acc + value, 0);
  return sum / numeric.length;
}

function summarizeCondition(values) {
  const filtered = values.filter(Boolean);
  if (!filtered.length) {
    return null;
  }

  const score = new Map();
  for (const condition of filtered) {
    score.set(condition, (score.get(condition) || 0) + 1);
  }

  let winner = null;
  let best = -1;
  for (const [name, amount] of score.entries()) {
    if (amount > best) {
      winner = name;
      best = amount;
    }
  }
  return winner;
}
