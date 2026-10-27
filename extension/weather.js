(() => {
  const STORAGE_KEY = "lazySongCounterWeather";
  const weekdayElement = document.querySelector("#date-weekday");
  const dateElement = document.querySelector("#date-value");
  const weatherButton = document.querySelector("#weather-location");
  const weatherValue = document.querySelector("#weather-value");
  const weatherSource = document.querySelector("#weather-source");
  const weatherForm = document.querySelector("#weather-form");
  const cityInput = document.querySelector("#weather-city");
  const searchButton = document.querySelector("#weather-search");
  const resultLabel = document.querySelector("#weather-result-label");
  const resultsSelect = document.querySelector("#weather-results");
  const useCityButton = document.querySelector("#weather-use-city");
  const closeButton = document.querySelector("#weather-close");
  const messageElement = document.querySelector("#weather-message");
  if ([weekdayElement, dateElement, weatherButton, weatherValue, weatherSource, weatherForm,
    cityInput, searchButton, resultLabel, resultsSelect, useCityButton, closeButton, messageElement]
    .some((element) => !element)) return;

  let cachedWeather = null;
  let locations = [];
  let busy = false;

  weatherButton.addEventListener("click", openPicker);
  closeButton.addEventListener("click", closePicker);
  weatherForm.addEventListener("submit", searchLocations);
  useCityButton.addEventListener("click", useSelectedCity);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    cachedWeather = changes[STORAGE_KEY].newValue || null;
    render();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !weatherForm.hidden) closePicker();
  });

  async function initialize() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      cachedWeather = result[STORAGE_KEY] || null;
    } catch {
      cachedWeather = null;
    }
    render();
    window.setInterval(renderDate, 60_000);
  }

  function openPicker() {
    weatherForm.hidden = false;
    weatherButton.setAttribute("aria-expanded", "true");
    cityInput.value = cachedWeather?.query || "";
    messageElement.textContent = cachedWeather?.location
      ? `Current weather for ${cachedWeather.location}. Search to choose a different place.`
      : "Enter a city or town. Chrome will ask before searching for it.";
    resultsSelect.hidden = true;
    resultLabel.hidden = true;
    useCityButton.hidden = true;
    locations = [];
    window.setTimeout(() => cityInput.focus(), 0);
  }

  function closePicker() {
    weatherForm.hidden = true;
    weatherButton.setAttribute("aria-expanded", "false");
  }

  async function searchLocations(event) {
    event.preventDefault();
    const query = cityInput.value.trim();
    if (!query) {
      messageElement.textContent = "Enter a city or town name first.";
      cityInput.focus();
      return;
    }

    const permissionRequest = requestGeocodingPermission();
    const permissionGranted = await permissionRequest;
    if (!permissionGranted) {
      messageElement.textContent = "Allow city search access to find local weather.";
      return;
    }

    setBusy(true, "Searching…");
    locations = [];
    resultsSelect.replaceChildren();
    resultsSelect.hidden = true;
    resultLabel.hidden = true;
    useCityButton.hidden = true;

    try {
      const params = new URLSearchParams({ name: query, count: "8", language: "en", format: "json" });
      const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
      if (!response.ok) throw new Error("Could not search for that place. Try again.");
      const data = await response.json();
      locations = Array.isArray(data.results) ? data.results : [];
      if (locations.length === 0) {
        messageElement.textContent = "No matching places. Add a country name and try again.";
        return;
      }

      locations.forEach((location, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = formatLocation(location);
        resultsSelect.append(option);
      });
      resultLabel.hidden = false;
      resultsSelect.hidden = false;
      useCityButton.hidden = false;
      messageElement.textContent = `Found ${locations.length} places. Choose the one you mean.`;
    } catch (error) {
      messageElement.textContent = error.message || "Could not search for that place.";
    } finally {
      setBusy(false);
    }
  }

  function requestGeocodingPermission() {
    return new Promise((resolve) => {
      chrome.permissions.request({ origins: ["https://geocoding-api.open-meteo.com/*"] }, (granted) => {
        const error = chrome.runtime.lastError;
        resolve(Boolean(granted && !error));
      });
    });
  }

  async function useSelectedCity() {
    const location = locations[Number(resultsSelect.value)];
    if (!location) {
      messageElement.textContent = "Choose a place from the list first.";
      return;
    }

    setBusy(true, "Loading weather…");
    try {
      const params = new URLSearchParams({
        latitude: Number(location.latitude).toFixed(2),
        longitude: Number(location.longitude).toFixed(2),
        current: "temperature_2m,weather_code,is_day",
        timezone: "auto",
        forecast_days: "1"
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!response.ok) throw new Error("Weather service is unavailable. Try again.");
      const forecast = await response.json();
      const current = forecast.current;
      if (!current || !Number.isFinite(Number(current.temperature_2m))) {
        throw new Error("Weather data is unavailable for this place.");
      }

      cachedWeather = {
        query: cityInput.value.trim(),
        location: formatLocation(location),
        timezone: typeof forecast.timezone === "string" ? forecast.timezone : "",
        temperature: Number(current.temperature_2m),
        weatherCode: Number(current.weather_code),
        isDay: Number(current.is_day) === 1,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: cachedWeather });
      render();
      closePicker();
    } catch (error) {
      messageElement.textContent = error.message || "Could not load weather for this place.";
    } finally {
      setBusy(false);
    }
  }

  function setBusy(value, message) {
    busy = value;
    searchButton.disabled = value;
    useCityButton.disabled = value;
    cityInput.disabled = value;
    resultsSelect.disabled = value;
    closeButton.disabled = value;
    searchButton.textContent = value && message.startsWith("Searching") ? "…" : "Find";
    if (message) messageElement.textContent = message;
  }

  function formatLocation(location) {
    return [location.name, location.admin1, location.country]
      .filter((part, index, parts) => part && parts.indexOf(part) === index)
      .join(", ");
  }

  function weatherDescription(code) {
    if (code === 0) return "Clear sky";
    if (code === 1) return "Mainly clear";
    if (code === 2) return "Partly cloudy";
    if (code === 3) return "Overcast";
    if (code === 45 || code === 48) return "Fog";
    if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
    if ([61, 63, 65, 66, 67].includes(code)) return "Rain";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
    if ([80, 81, 82].includes(code)) return "Rain showers";
    if ([95, 96, 99].includes(code)) return "Thunderstorm";
    return "Local weather";
  }

  function weatherIcon(code, isDay) {
    if (code === 0) return isDay ? "☀" : "☾";
    if (code === 1 || code === 2) return isDay ? "⛅" : "☁";
    if (code === 3 || code === 45 || code === 48) return "☁";
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄";
    if ([95, 96, 99].includes(code)) return "⛈";
    return "🌡";
  }

  function render() {
    renderDate();
    if (!cachedWeather) {
      weatherValue.textContent = "Set city";
      weatherButton.title = "Choose a city to show local weather. No device location is requested.";
      weatherButton.setAttribute("aria-label", "Choose a city for local weather");
      weatherSource.hidden = true;
      return;
    }

    const code = Number(cachedWeather.weatherCode);
    const description = weatherDescription(code);
    const temperature = Math.round(Number(cachedWeather.temperature));
    weatherValue.textContent = `${weatherIcon(code, cachedWeather.isDay)} ${temperature}°`;
    weatherSource.hidden = false;
    const updated = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "short",
      ...(cachedWeather.timezone ? { timeZone: cachedWeather.timezone } : {})
    }).format(cachedWeather.updatedAt);
    weatherButton.title = `${cachedWeather.location} · ${description} · Updated ${updated}. Click to change city or refresh.`;
    weatherButton.setAttribute("aria-label", `${cachedWeather.location}, ${temperature} degrees, ${description}. Change city or refresh weather.`);
  }

  function renderDate() {
    const options = cachedWeather?.timezone ? { timeZone: cachedWeather.timezone } : {};
    try {
      weekdayElement.textContent = new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        ...options
      }).format(new Date()).toLocaleUpperCase();
      dateElement.textContent = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        ...options
      }).format(new Date());
    } catch {
      weekdayElement.textContent = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(new Date()).toLocaleUpperCase();
      dateElement.textContent = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date());
    }
  }

  void initialize();
})();
