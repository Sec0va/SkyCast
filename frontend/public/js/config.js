export const SOURCE_ORDER = ["meteoinfo", "gismeteo", "yandex", "weathercom", "meteoblue", "wunderground"];

export const SOURCE_TITLE = {
  meteoinfo: "Meteoinfo.ru",
  gismeteo: "GISMETEO.ru",
  yandex: "\u042f\u043d\u0434\u0435\u043a\u0441 \u041f\u043e\u0433\u043e\u0434\u0430",
  weathercom: "Weather.com",
  meteoblue: "MeteoBlue",
  wunderground: "Weather Underground",
};

export const SOURCE_DESCRIPTION = {
  meteoblue:
    "\u041f\u043e\u0434\u0440\u043e\u0431\u043d\u044b\u0435 \u043f\u0440\u043e\u0433\u043d\u043e\u0437\u044b \u0434\u043b\u044f \u043b\u044e\u0431\u043e\u0433\u043e \u043d\u0430\u0441\u0435\u043b\u0451\u043d\u043d\u043e\u0433\u043e \u043f\u0443\u043d\u043a\u0442\u0430, \u0433\u0440\u0430\u0444\u0438\u043a\u0438 \u0442\u0435\u043c\u043f\u0435\u0440\u0430\u0442\u0443\u0440\u044b \u0438 \u043e\u0441\u0430\u0434\u043a\u043e\u0432.",
  wunderground:
    "\u041f\u0440\u043e\u0433\u043d\u043e\u0437\u044b \u043f\u043e \u043c\u0435\u0441\u0442\u043e\u043f\u043e\u043b\u043e\u0436\u0435\u043d\u0438\u044e, \u0434\u0430\u043d\u043d\u044b\u0435 \u043c\u0435\u0442\u0435\u043e\u0441\u0442\u0430\u043d\u0446\u0438\u0439, \u0438\u0441\u0442\u043e\u0440\u0438\u044f \u043f\u043e\u0433\u043e\u0434\u044b.",
};

export const CITY_NAME_BY_KEY = {
  moscow: "\u041c\u043e\u0441\u043a\u0432\u0430, RU",
  "saint-petersburg": "\u0421\u0430\u043d\u043a\u0442-\u041f\u0435\u0442\u0435\u0440\u0431\u0443\u0440\u0433, RU",
  novosibirsk: "\u041d\u043e\u0432\u043e\u0441\u0438\u0431\u0438\u0440\u0441\u043a, RU",
  kazan: "\u041a\u0430\u0437\u0430\u043d\u044c, RU",
};

export const STORAGE_KEY = "weather_ui_settings_v1";
export const THEME_STORAGE_KEY = "theme";
export const AUTO_REFRESH_MS = 30000;
export const CITY_AUTOCOMPLETE_DELAY_MS = 300;
export const CITY_AUTOCOMPLETE_LIMIT = 5;
export const CITY_GEOCODING_API = "https://geocoding-api.open-meteo.com/v1/search";
export const CITY_GEOCODING_GET_API = "https://geocoding-api.open-meteo.com/v1/get";

export const DEFAULT_SETTINGS = Object.freeze({
  tempUnit: "c",
  windUnit: "kph",
  pressureUnit: "hpa",
  showComparison: false,
  showUpdateStatus: false,
});

export const DEFAULT_CITY = "\u041c\u043e\u0441\u043a\u0432\u0430";