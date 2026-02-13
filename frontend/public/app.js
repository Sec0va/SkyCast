const SOURCE_ORDER = ["meteoinfo", "gismeteo", "yandex", "weathercom", "meteoblue", "wunderground"];
const SOURCE_TITLE = {
  meteoinfo: "Meteoinfo.ru",
  gismeteo: "GISMETEO.ru",
  yandex: "Яндекс Погода",
  weathercom: "Weather.com",
  meteoblue: "MeteoBlue",
  wunderground: "Weather Underground",
};
const SOURCE_DESCRIPTION = {
  meteoblue: "Подробные прогнозы для любого населённого пункта, графики температуры и осадков.",
  wunderground: "Прогнозы по местоположению, данные метеостанций, история погоды.",
};
const CITY_NAME_BY_KEY = {
  moscow: "Москва, RU",
  "saint-petersburg": "Санкт-Петербург, RU",
  novosibirsk: "Новосибирск, RU",
  kazan: "Казань, RU",
};
const STORAGE_KEY = "weather_ui_settings_v1";
const THEME_STORAGE_KEY = "theme";
const AUTO_REFRESH_MS = 30000;
const CITY_AUTOCOMPLETE_DELAY_MS = 300;
const CITY_AUTOCOMPLETE_LIMIT = 5;
const CITY_GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
const CITY_GEOCODING_GET_API = "https://geocoding-api.open-meteo.com/v1/get";
const DEFAULT_SETTINGS = Object.freeze({
  tempUnit: "c",
  windUnit: "kph",
  pressureUnit: "hpa",
  showComparison: false,
  showUpdateStatus: false,
});

const state = {
  city: "Москва",
  stream: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  autoRefreshTimer: null,
  autocompleteTimer: null,
  autocompleteController: null,
  citySuggestions: [],
  lastSnapshot: null,
  theme: loadThemePreference(),
  settings: loadSettings(),
};

const els = {
  cityForm: document.getElementById("cityForm"),
  cityInput: document.getElementById("cityInput"),
  cityGeoBtn: document.getElementById("cityGeoBtn"),
  citySuggestions: document.getElementById("citySuggestions"),
  refreshBtn: document.getElementById("refreshBtn"),
  connectionBadge: document.getElementById("connectionBadge"),
  cityName: document.getElementById("cityName"),
  summaryCondition: document.getElementById("summaryCondition"),
  summaryTemp: document.getElementById("summaryTemp"),
  summaryTempUnit: document.getElementById("summaryTempUnit"),
  summaryFeelsLike: document.getElementById("summaryFeelsLike"),
  summaryHumidity: document.getElementById("summaryHumidity"),
  summaryWind: document.getElementById("summaryWind"),
  summaryPressure: document.getElementById("summaryPressure"),
  summarySources: document.getElementById("summarySources"),
  summaryUpdated: document.getElementById("summaryUpdated"),
  summaryColumn: document.getElementById("summaryColumn"),
  statusColumn: document.getElementById("statusColumn"),
  sourcesGrid: document.getElementById("sourcesGrid"),
  sourcesSection: document.getElementById("sourcesSection"),
  settingsMenu: document.getElementById("settingsMenu"),
  settingsToggle: document.getElementById("settingsToggle"),
  settingsPanel: document.getElementById("settingsPanel"),
  tempUnitSelect: document.getElementById("tempUnitSelect"),
  windUnitSelect: document.getElementById("windUnitSelect"),
  pressureUnitSelect: document.getElementById("pressureUnitSelect"),
  themeToggle: document.getElementById("themeToggle"),
  compareModeToggle: document.getElementById("compareModeToggle"),
  statusPanelToggle: document.getElementById("statusPanelToggle"),
  forecastSummary: document.getElementById("forecastSummary"),
  forecastProvider: document.getElementById("forecastProvider"),
  weeklyForecastGrid: document.getElementById("weeklyForecastGrid"),
};

init();

function init() {
  applyTheme(state.theme);
  renderSourceCards([]);
  renderWeeklyForecast(null);
  bindUi();
  syncSettingsControls();
  applySettingsUi();
  startAutoRefresh();
  connect(state.city);
  loadSnapshot(state.city);
}

function bindUi() {
  els.cityInput.value = state.city;

  els.cityForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const requestedCity = els.cityInput.value.trim();
    if (!requestedCity) {
      return;
    }

    cancelCityAutocomplete();
    hideCitySuggestions();
    requestCityWeather(requestedCity);
  });

  if (els.refreshBtn) {
    els.refreshBtn.addEventListener("click", async () => {
      await forceRefresh(state.city);
    });
  }

  bindCityAutocomplete();
  bindCityGeolocation();
  bindSettingsMenu();
}

function requestCityWeather(cityName) {
  const requestedCity = String(cityName || "").trim();
  if (!requestedCity) {
    return;
  }

  state.city = requestedCity;
  state.reconnectAttempt = 0;
  clearReconnectTimer();
  setBadge("connecting", "Подключение");
  connect(requestedCity);
  loadSnapshot(requestedCity);
}

function bindCityGeolocation() {
  if (!els.cityGeoBtn) {
    return;
  }

  els.cityGeoBtn.addEventListener("click", () => {
    void locateCityByGeolocation();
  });
}

async function locateCityByGeolocation() {
  if (!els.cityInput || !els.cityGeoBtn) {
    return;
  }

  if (!("geolocation" in navigator) || typeof navigator.geolocation.getCurrentPosition !== "function") {
    setBadge("error", "Геолокация недоступна");
    window.alert("Браузер не поддерживает геолокацию.");
    return;
  }

  if (els.cityGeoBtn.classList.contains("is-loading")) {
    return;
  }

  setGeoButtonLoading(true);
  setBadge("connecting", "Поиск геопозиции");

  try {
    const position = await getCurrentPosition();
    const cityName = await loadCityNameByCoordinates(position.coords.latitude, position.coords.longitude);

    if (!cityName) {
      throw new Error("CITY_NOT_FOUND");
    }

    els.cityInput.value = cityName;
    cancelCityAutocomplete();
    hideCitySuggestions();
    requestCityWeather(cityName);
  } catch (error) {
    setBadge("error", "Ошибка геолокации");
    window.alert(getGeolocationErrorMessage(error));
  } finally {
    setGeoButtonLoading(false);
  }
}

function setGeoButtonLoading(isLoading) {
  if (!els.cityGeoBtn) {
    return;
  }
  els.cityGeoBtn.classList.toggle("is-loading", isLoading);
  els.cityGeoBtn.disabled = isLoading;
  els.cityGeoBtn.setAttribute("aria-busy", String(isLoading));
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 10000,
      maximumAge: 300000,
    });
  });
}

async function loadCityNameByCoordinates(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    language: "ru",
  });

  const response = await fetch(`${CITY_GEOCODING_GET_API}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`CITY_LOOKUP_FAILED_${response.status}`);
  }

  const payload = await response.json();
  const candidates = [
    payload && payload.name,
    payload && payload.city,
    payload && payload.locality,
    payload && payload.results && payload.results[0] && payload.results[0].name,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function getGeolocationErrorMessage(error) {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === 1) {
      return "Доступ к геолокации запрещен. Разрешите доступ в браузере.";
    }
    if (error.code === 2) {
      return "Не удалось определить текущее местоположение.";
    }
    if (error.code === 3) {
      return "Превышено время ожидания геолокации.";
    }
  }

  if (error instanceof Error && error.message === "CITY_NOT_FOUND") {
    return "Город по текущим координатам не найден.";
  }

  return "Не удалось определить город по геолокации.";
}

function bindCityAutocomplete() {
  if (!els.cityInput || !els.citySuggestions || !els.cityForm) {
    return;
  }

  els.cityInput.addEventListener("input", () => {
    const query = els.cityInput.value.trim();
    clearAutocompleteTimer();

    if (!query) {
      cancelCityAutocomplete();
      hideCitySuggestions();
      return;
    }

    state.autocompleteTimer = window.setTimeout(() => {
      void loadCitySuggestions(query);
    }, CITY_AUTOCOMPLETE_DELAY_MS);
  });

  els.citySuggestions.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) {
      return;
    }

    const option = event.target.closest("[data-city-index]");
    if (!option) {
      return;
    }

    const index = Number(option.getAttribute("data-city-index"));
    const selected = state.citySuggestions[index];
    if (!selected || !selected.name) {
      return;
    }

    els.cityInput.value = selected.name;
    cancelCityAutocomplete();
    hideCitySuggestions();
    requestCityWeather(selected.name);
  });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node)) {
      return;
    }
    if (!els.cityForm.contains(event.target)) {
      hideCitySuggestions();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideCitySuggestions();
    }
  });
}

function clearAutocompleteTimer() {
  if (!state.autocompleteTimer) {
    return;
  }
  window.clearTimeout(state.autocompleteTimer);
  state.autocompleteTimer = null;
}

function cancelCityAutocomplete() {
  clearAutocompleteTimer();
  if (!state.autocompleteController) {
    return;
  }
  state.autocompleteController.abort();
  state.autocompleteController = null;
}

async function loadCitySuggestions(query) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    hideCitySuggestions();
    return;
  }

  if (state.autocompleteController) {
    state.autocompleteController.abort();
  }

  const controller = new AbortController();
  state.autocompleteController = controller;
  const params = new URLSearchParams({
    name: normalizedQuery,
    count: String(CITY_AUTOCOMPLETE_LIMIT),
    language: "ru",
  });

  try {
    const response = await fetch(`${CITY_GEOCODING_API}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Geocoding request failed with ${response.status}`);
    }

    const payload = await response.json();
    if (state.autocompleteController !== controller) {
      return;
    }
    state.autocompleteController = null;

    if (els.cityInput.value.trim() !== normalizedQuery) {
      return;
    }

    const suggestions = normalizeCitySuggestions(payload && payload.results);
    renderCitySuggestions(suggestions);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    state.autocompleteController = null;
    hideCitySuggestions();
  }
}

function normalizeCitySuggestions(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  return results
    .map((row) => ({
      name: typeof row?.name === "string" ? row.name.trim() : "",
      admin1: typeof row?.admin1 === "string" ? row.admin1.trim() : "",
      country: typeof row?.country === "string" ? row.country.trim() : "",
    }))
    .filter((row) => Boolean(row.name))
    .slice(0, CITY_AUTOCOMPLETE_LIMIT);
}

function renderCitySuggestions(suggestions) {
  if (!els.citySuggestions) {
    return;
  }

  state.citySuggestions = Array.isArray(suggestions) ? suggestions : [];
  if (!state.citySuggestions.length) {
    hideCitySuggestions();
    return;
  }

  els.citySuggestions.innerHTML = state.citySuggestions
    .map((city, index) => {
      const locationDetails = [city.admin1, city.country].filter(Boolean).join(", ");
      const detailsHtml = locationDetails
        ? `<span class="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">${escapeHtml(locationDetails)}</span>`
        : "";

      return `
        <button
          type="button"
          class="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-50 focus:bg-slate-50 focus:outline-none last:border-b-0 dark:border-slate-700 dark:text-slate-100 dark:hover:bg-slate-700/40 dark:focus:bg-slate-700/40"
          data-city-index="${index}"
          role="option"
        >
          <span class="block">${escapeHtml(city.name)}</span>
          ${detailsHtml}
        </button>
      `;
    })
    .join("");

  els.citySuggestions.classList.remove("hidden");
}

function hideCitySuggestions() {
  if (!els.citySuggestions) {
    return;
  }
  els.citySuggestions.classList.add("hidden");
  els.citySuggestions.innerHTML = "";
  state.citySuggestions = [];
}

function bindSettingsMenu() {
  if (els.settingsToggle && els.settingsPanel && els.settingsMenu) {
    els.settingsToggle.addEventListener("click", () => {
      const isOpen = !els.settingsPanel.classList.contains("hidden");
      setSettingsPanelOpen(!isOpen);
    });

    document.addEventListener("click", (event) => {
      if (els.settingsPanel.classList.contains("hidden")) {
        return;
      }
      if (!els.settingsMenu.contains(event.target)) {
        setSettingsPanelOpen(false);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setSettingsPanelOpen(false);
      }
    });
  }

  if (els.tempUnitSelect) {
    els.tempUnitSelect.addEventListener("change", () => {
      updateSettings({ tempUnit: sanitizeTempUnit(els.tempUnitSelect.value) });
    });
  }

  if (els.windUnitSelect) {
    els.windUnitSelect.addEventListener("change", () => {
      updateSettings({ windUnit: sanitizeWindUnit(els.windUnitSelect.value) });
    });
  }

  if (els.pressureUnitSelect) {
    els.pressureUnitSelect.addEventListener("change", () => {
      updateSettings({ pressureUnit: sanitizePressureUnit(els.pressureUnitSelect.value) });
    });
  }

  if (els.compareModeToggle) {
    els.compareModeToggle.addEventListener("change", () => {
      updateSettings({ showComparison: els.compareModeToggle.checked });
    });
  }

  if (els.themeToggle) {
    els.themeToggle.addEventListener("change", () => {
      updateTheme(els.themeToggle.checked);
    });
  }

  if (els.statusPanelToggle) {
    els.statusPanelToggle.addEventListener("change", () => {
      updateSettings({ showUpdateStatus: els.statusPanelToggle.checked });
    });
  }
}

function setSettingsPanelOpen(open) {
  if (!els.settingsPanel || !els.settingsToggle) {
    return;
  }
  els.settingsPanel.classList.toggle("hidden", !open);
  els.settingsToggle.setAttribute("aria-expanded", String(open));
}

function updateSettings(partial) {
  state.settings = sanitizeSettings({ ...state.settings, ...partial });
  saveSettings(state.settings);
  syncSettingsControls();
  applySettingsUi();
  if (state.lastSnapshot) {
    renderSnapshot(state.lastSnapshot);
  }
}

function syncSettingsControls() {
  if (els.tempUnitSelect) {
    els.tempUnitSelect.value = state.settings.tempUnit;
  }
  if (els.windUnitSelect) {
    els.windUnitSelect.value = state.settings.windUnit;
  }
  if (els.pressureUnitSelect) {
    els.pressureUnitSelect.value = state.settings.pressureUnit;
  }
  if (els.themeToggle) {
    els.themeToggle.checked = state.theme === "dark";
  }
  if (els.compareModeToggle) {
    els.compareModeToggle.checked = state.settings.showComparison;
  }
  if (els.statusPanelToggle) {
    els.statusPanelToggle.checked = state.settings.showUpdateStatus;
  }
}

function updateTheme(isDark) {
  state.theme = isDark ? "dark" : "light";
  applyTheme(state.theme);
  saveThemePreference(state.theme);
}

function applySettingsUi() {
  if (els.summaryTempUnit) {
    els.summaryTempUnit.textContent = getTemperatureUnitLabel();
  }
  if (els.sourcesSection) {
    els.sourcesSection.hidden = !state.settings.showComparison;
  }
  if (els.summarySources) {
    els.summarySources.hidden = !state.settings.showComparison;
  }
  if (els.statusColumn) {
    els.statusColumn.hidden = !state.settings.showUpdateStatus;
  }
  if (els.summaryColumn) {
    els.summaryColumn.classList.toggle("lg:col-span-12", !state.settings.showUpdateStatus);
    els.summaryColumn.classList.toggle("lg:col-span-7", state.settings.showUpdateStatus);
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.autoRefreshTimer = window.setInterval(() => {
    loadSnapshot(state.city);
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) {
    window.clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
}

async function forceRefresh(city) {
  setBadge("connecting", "Обновление");
  try {
    const response = await fetch(`/api/refresh?city=${encodeURIComponent(city)}`, {
      method: "POST",
    });
    const payload = await response.json();
    renderSnapshot(payload);
    setBadge("live", "В эфире");
  } catch {
    setBadge("error", "Ошибка обновления");
  }
}

async function loadSnapshot(city) {
  try {
    const response = await fetch(`/api/weather?city=${encodeURIComponent(city)}`);
    const payload = await response.json();
    renderSnapshot(payload);
  } catch {
    setBadge("error", "Ошибка загрузки");
  }
}

function connect(city) {
  disconnect();
  const url = `/api/stream?city=${encodeURIComponent(city)}`;
  const stream = new EventSource(url);
  state.stream = stream;

  setBadge("connecting", "Подключение");

  stream.onopen = () => {
    state.reconnectAttempt = 0;
    clearReconnectTimer();
    setBadge("live", "В эфире");
  };

  stream.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      renderSnapshot(payload);
    } catch {
      setBadge("error", "Ошибка потока");
    }
  };

  stream.onerror = () => {
    setBadge("error", "Переподключение");
    disconnect();
    scheduleReconnect(city);
  };
}

function disconnect() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function scheduleReconnect(city) {
  clearReconnectTimer();
  state.reconnectAttempt += 1;
  const delay = Math.min(15000, 1200 * state.reconnectAttempt);
  state.reconnectTimer = window.setTimeout(() => {
    connect(city);
  }, delay);
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function setBadge(kind, text) {
  if (!els.connectionBadge) {
    return;
  }
  els.connectionBadge.textContent = text;
  els.connectionBadge.className = `badge ${kind}`;
}

function renderSnapshot(snapshot) {
  if (!snapshot || !snapshot.aggregate || !Array.isArray(snapshot.sources)) {
    return;
  }

  state.lastSnapshot = snapshot;

  els.cityName.textContent =
    CITY_NAME_BY_KEY[snapshot.cityKey] || localizeCityName(snapshot.city || snapshot.cityQuery || state.city);
  els.summaryCondition.textContent = translateCondition(snapshot.aggregate.condition) || "Состояние недоступно";
  els.summaryTemp.textContent = formatTemperatureValue(snapshot.aggregate.temperatureC);
  els.summaryTempUnit.textContent = getTemperatureUnitLabel();
  els.summaryFeelsLike.textContent = formatTemperature(snapshot.aggregate.feelsLikeC);
  els.summaryHumidity.textContent = formatPercent(snapshot.aggregate.humidityPct);
  els.summaryWind.textContent = formatWind(snapshot.aggregate.windKph);
  els.summaryPressure.textContent = formatPressure(snapshot.aggregate.pressureHpa);
  els.summarySources.textContent = `Источники: ${snapshot.aggregate.sourceCount} из ${snapshot.aggregate.expectedSourceCount}`;
  els.summaryUpdated.textContent = `Обновлено: ${formatClock(snapshot.fetchedAt)}`;

  renderSourceCards(snapshot.sources);
  renderWeeklyForecast(snapshot.forecast || null);
}

function renderWeeklyForecast(forecast) {
  if (!els.weeklyForecastGrid) {
    return;
  }

  const daily = forecast && Array.isArray(forecast.daily) ? forecast.daily.slice(0, 7) : [];

  if (els.forecastProvider) {
    els.forecastProvider.textContent = `Прогноз: ${getForecastProviderLabel(forecast && forecast.provider)}`;
  }

  if (els.forecastSummary) {
    const base = "Ночь, утро, день и вечер для каждого дня";
    els.forecastSummary.textContent = forecast && forecast.generatedAt ? `${base} | обновлено ${formatClock(forecast.generatedAt)}` : base;
  }

  if (!daily.length) {
    els.weeklyForecastGrid.innerHTML = `
      <article class="forecast-day-card">
        <p class="forecast-day-name">Прогноз временно недоступен</p>
        <p class="forecast-day-date">Данные появятся после следующего обновления</p>
      </article>
    `;
    return;
  }

  els.weeklyForecastGrid.innerHTML = daily.map((day, index) => renderWeeklyForecastDay(day, index)).join("");
}

function renderWeeklyForecastDay(day, index) {
  const condition = translateCondition(day && day.condition) || "--";
  const chancePct = Number.isFinite(day && day.precipChancePct) ? `${Math.round(day.precipChancePct)}%` : "--";
  const precipMm = Number.isFinite(day && day.precipMm) ? `${numberRu(round1(day.precipMm))} мм` : "--";
  const periods = Array.isArray(day && day.periods) ? day.periods : [];

  return `
    <article class="forecast-day-card">
      <div class="forecast-day-top">
        <div>
          <p class="forecast-day-name">${escapeHtml(formatForecastDayLabel(day && day.date, index))}</p>
          <p class="forecast-day-date">${escapeHtml(formatForecastDateLabel(day && day.date))}</p>
        </div>
        <p class="forecast-condition">${escapeHtml(condition)}</p>
      </div>

      <div class="forecast-temp-row">
        <p class="forecast-temp-main">${formatCompactTemperature(day && day.tempMaxC)}</p>
        <p class="forecast-temp-main">${formatCompactTemperature(day && day.tempMinC)}</p>
      </div>

      <p class="forecast-precip">Осадки: ${chancePct} | ${precipMm}</p>
      <div class="forecast-period-grid">
        ${renderForecastPeriods(periods)}
      </div>
    </article>
  `;
}

function renderForecastPeriods(periods) {
  const byKey = new Map((Array.isArray(periods) ? periods : []).map((period) => [period && period.key, period]));
  const order = ["night", "morning", "day", "evening"];

  return order
    .map((key) => {
      const period = byKey.get(key) || {};
      const condition = translateCondition(period.condition) || "--";
      const chancePct = Number.isFinite(period.precipChancePct) ? `${Math.round(period.precipChancePct)}%` : "--";
      const precipMm =
        Number.isFinite(period.precipMm) && period.precipMm > 0 ? `${numberRu(round1(period.precipMm))} мм` : "";
      const extra = precipMm ? `${chancePct} | ${precipMm}` : chancePct;

      return `
        <article class="forecast-period">
          <p class="forecast-period-label">${getForecastPeriodLabel(key)}</p>
          <p class="forecast-period-temp">${formatCompactTemperature(period.tempC)}</p>
          <p class="forecast-period-cond">${escapeHtml(condition)}</p>
          <p class="forecast-period-extra">${extra}</p>
        </article>
      `;
    })
    .join("");
}

function getForecastProviderLabel(provider) {
  if (provider === "open-meteo") {
    return "Open-Meteo";
  }
  if (provider === "synthetic") {
    return "Локальная модель";
  }
  return "--";
}

function getForecastPeriodLabel(periodKey) {
  if (periodKey === "night") {
    return "Ночь";
  }
  if (periodKey === "morning") {
    return "Утро";
  }
  if (periodKey === "day") {
    return "День";
  }
  return "Вечер";
}

function formatForecastDayLabel(rawDate, index) {
  if (index === 0) {
    return "Сегодня";
  }
  if (index === 1) {
    return "Завтра";
  }

  const date = parseForecastDate(rawDate);
  if (!date) {
    return `День ${index + 1}`;
  }

  const label = new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", "");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatForecastDateLabel(rawDate) {
  const date = parseForecastDate(rawDate);
  if (!date) {
    return "--";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
  })
    .format(date)
    .replace(".", "");
}

function parseForecastDate(rawDate) {
  if (!rawDate) {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(String(rawDate))
    ? `${rawDate}T00:00:00`
    : String(rawDate);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function formatCompactTemperature(valueC) {
  if (!Number.isFinite(valueC)) {
    return "--";
  }
  const converted = convertTemperature(valueC);
  const unit = state.settings.tempUnit === "f" ? "°F" : "°C";
  return `${numberRu(round1(converted))}${unit}`;
}

function renderSourceCards(sourceRows) {
  const map = new Map(sourceRows.map((row) => [row.source, row]));
  els.sourcesGrid.innerHTML = SOURCE_ORDER.map((sourceKey) => renderSingleSource(map.get(sourceKey), sourceKey)).join("");
}

function renderSingleSource(row, sourceKey) {
  const title = SOURCE_TITLE[sourceKey] || sourceKey;
  const sourceDescription = SOURCE_DESCRIPTION[sourceKey]
    ? `<p class="source-description">${escapeHtml(SOURCE_DESCRIPTION[sourceKey])}</p>`
    : "";
  if (!row) {
    return `
      <article class="source-card">
        <div class="source-top">
          <h4 class="source-title">${escapeHtml(title)}</h4>
          <span class="source-state fail">Нет данных</span>
        </div>
        <p class="source-temp">--</p>
        <p class="source-condition">Ожидается обновление</p>
        ${sourceDescription}
      </article>
    `;
  }

  const ok = row.ok === true;
  const stateLabel = ok ? "Онлайн" : "Оффлайн";
  const stateClass = ok ? "ok" : "fail";
  const sourceLink = row.url
    ? `<a class="source-link" href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">Открыть источник</a>`
    : "Ссылка недоступна";
  const error = ok ? "" : `<p class="source-error">${escapeHtml(row.error || "Источник недоступен")}</p>`;

  return `
    <article class="source-card">
      <div class="source-top">
        <h4 class="source-title">${escapeHtml(title)}</h4>
        <span class="source-state ${stateClass}">${stateLabel}</span>
      </div>
      <p class="source-temp">${formatTemperature(row.temperatureC)}</p>
      <p class="source-condition">${escapeHtml(translateCondition(row.condition) || "Состояние недоступно")}</p>
      ${sourceDescription}
      <ul class="source-metrics">
        <li>Ощущается: ${formatTemperature(row.feelsLikeC)}</li>
        <li>Влажность: ${formatPercent(row.humidityPct)}</li>
        <li>Ветер: ${formatWind(row.windKph)}</li>
        <li>Давление: ${formatPressure(row.pressureHpa)}</li>
      </ul>
      <div class="source-meta">
        <span>${sourceLink}</span>
        <span>${formatClock(row.fetchedAt)}</span>
      </div>
      ${error}
    </article>
  `;
}

function formatTemperatureValue(valueC) {
  if (!Number.isFinite(valueC)) {
    return "--";
  }
  const value = convertTemperature(valueC);
  return numberRu(round1(value));
}

function formatTemperature(valueC) {
  if (!Number.isFinite(valueC)) {
    return "--";
  }
  const value = convertTemperature(valueC);
  return `${numberRu(round1(value))} ${getTemperatureUnitLabel()}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${Math.round(value)}%`;
}

function formatWind(valueKph) {
  if (!Number.isFinite(valueKph)) {
    return "--";
  }
  const converted = convertWind(valueKph);
  return `${numberRu(round1(converted.value))} ${converted.unit}`;
}

function formatPressure(valueHpa) {
  if (!Number.isFinite(valueHpa)) {
    return "--";
  }
  const converted = convertPressure(valueHpa);
  return `${numberRu(converted.value)} ${converted.unit}`;
}

function convertTemperature(valueC) {
  if (state.settings.tempUnit === "f") {
    return valueC * (9 / 5) + 32;
  }
  return valueC;
}

function convertWind(valueKph) {
  if (state.settings.windUnit === "mph") {
    return { value: valueKph * 0.621371, unit: "миль/ч" };
  }
  if (state.settings.windUnit === "mps") {
    return { value: valueKph / 3.6, unit: "м/с" };
  }
  return { value: valueKph, unit: "км/ч" };
}

function convertPressure(valueHpa) {
  if (state.settings.pressureUnit === "mmhg") {
    return { value: Math.round(valueHpa * 0.750061683), unit: "мм рт. ст." };
  }
  return { value: Math.round(valueHpa), unit: "гПа" };
}

function getTemperatureUnitLabel() {
  return state.settings.tempUnit === "f" ? "°F" : "°C";
}

function formatClock(iso) {
  if (!iso) {
    return "--:--";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  return new Intl.DateTimeFormat("ru-RU", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function numberRu(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
}

function localizeCityName(rawName) {
  const text = String(rawName || "").trim();
  if (!text) {
    return state.city;
  }

  if (/^moscow/i.test(text)) {
    return text.replace(/^moscow/i, "Москва");
  }
  if (/^saint petersburg/i.test(text)) {
    return text.replace(/^saint petersburg/i, "Санкт-Петербург");
  }
  if (/^novosibirsk/i.test(text)) {
    return text.replace(/^novosibirsk/i, "Новосибирск");
  }
  if (/^kazan/i.test(text)) {
    return text.replace(/^kazan/i, "Казань");
  }
  return text;
}

function translateCondition(value) {
  if (!value) {
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const normalized = text.toLowerCase();
  if (/(thunder|storm|гроз)/.test(normalized)) {
    return "Гроза";
  }
  if (/(snow|sleet|blizzard|снег|метел)/.test(normalized)) {
    return "Снег";
  }
  if (/(rain|drizzle|shower|дожд)/.test(normalized)) {
    return "Дождь";
  }
  if (/(fog|mist|haze|туман)/.test(normalized)) {
    return "Туман";
  }
  if (/(cloud|overcast|пасмур|облач)/.test(normalized)) {
    return "Облачно";
  }
  if (/(clear|sunny|ясно|солнеч)/.test(normalized)) {
    return "Ясно";
  }

  return text;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in restricted browser modes.
  }
}

function loadThemePreference() {
  try {
    return sanitizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "light";
  }
}

function saveThemePreference(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, sanitizeTheme(theme));
  } catch {
    // Storage can be unavailable in restricted browser modes.
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  const normalized = sanitizeTheme(theme);
  const isDark = normalized === "dark";
  root.classList.toggle("dark", isDark);
  root.classList.toggle("light", !isDark);
}

function sanitizeSettings(raw) {
  return {
    tempUnit: sanitizeTempUnit(raw.tempUnit),
    windUnit: sanitizeWindUnit(raw.windUnit),
    pressureUnit: sanitizePressureUnit(raw.pressureUnit),
    showComparison: Boolean(raw.showComparison),
    showUpdateStatus: Boolean(raw.showUpdateStatus),
  };
}

function sanitizeTempUnit(value) {
  return value === "f" ? "f" : "c";
}

function sanitizeWindUnit(value) {
  if (value === "mph" || value === "mps") {
    return value;
  }
  return "kph";
}

function sanitizePressureUnit(value) {
  return value === "mmhg" ? "mmhg" : "hpa";
}

function sanitizeTheme(value) {
  return value === "dark" ? "dark" : "light";
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

