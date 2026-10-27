(() => {
  const STORAGE_KEY = "lazySongCounterWeather";
  const weekdayElement = document.querySelector("#date-weekday");
  const dateElement = document.querySelector("#date-value");
  const weatherButton = document.querySelector("#weather-location");
  const weatherValue = document.querySelector("#weather-value");
  const weatherSource = document.querySelector("#weather-source");
  if (!weekdayElement || !dateElement || !weatherButton || !weatherValue || !weatherSource) return;

  let cachedWeather = null;
  let busy = false;

  weatherButton.addEventListener("click", updateWeather);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    cachedWeather = changes[STORAGE_KEY].newValue || null;
    render();
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

  async function updateWeather() {
    if (busy) return;
    busy = true;
    weatherButton.disabled = true;
    weatherValue.textContent = "Locating…";
    weatherButton.title = "Getting local weather…";

    try {
      const position = await getPosition();
      const params = new URLSearchParams({
        latitude: position.coords.latitude.toFixed(2),
        longitude: position.coords.longitude.toFixed(2),
        current: "temperature_2m,weather_code,is_day",
        timezone: "auto",
        forecast_days: "1"
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
      if (!response.ok) throw new Error("Weather service is unavailable.");
      const forecast = await response.json();
      const current = forecast.current;
      if (!current || !Number.isFinite(Number(current.temperature_2m))) {
        throw new Error("Weather data is unavailable for this location.");
      }

      cachedWeather = {
        timezone: typeof forecast.timezone === "string" ? forecast.timezone : "",
        temperature: Number(current.temperature_2m),
        weatherCode: Number(current.weather_code),
        isDay: Number(current.is_day) === 1,
        updatedAt: Date.now()
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: cachedWeather });
      render();
    } catch (error) {
      weatherValue.textContent = "Weather unavailable";
      weatherButton.title = error.message || "Allow location access and try again.";
      weatherButton.setAttribute("aria-label", `${weatherButton.title} Retry local weather.`);
      weatherSource.hidden = !cachedWeather;
    } finally {
      busy = false;
      weatherButton.disabled = false;
    }
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Location is unavailable in this browser."));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, (error) => {
        const message = error.code === error.PERMISSION_DENIED
          ? "Location permission is required for local weather."
          : error.code === error.TIMEOUT
            ? "Location request timed out. Try again."
            : "Could not determine your location. Try again.";
        reject(new Error(message));
      }, {
        enableHighAccuracy: false,
        maximumAge: 10 * 60 * 1000,
        timeout: 12_000
      });
    });
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
      weatherValue.textContent = "Add weather";
      weatherButton.title = "Use your location for local weather. Rounded coordinates are sent to Open-Meteo and not saved.";
      weatherButton.setAttribute("aria-label", "Use your location for local weather. Rounded coordinates are sent to Open-Meteo and not saved.");
      weatherSource.hidden = true;
      return;
    }

    const code = Number(cachedWeather.weatherCode);
    const description = weatherDescription(code);
    const icon = weatherIcon(code, cachedWeather.isDay);
    const temperature = Math.round(Number(cachedWeather.temperature));
    weatherValue.textContent = `${icon} ${temperature}°`;
    weatherSource.hidden = false;
    const updated = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "short",
      ...(cachedWeather.timezone ? { timeZone: cachedWeather.timezone } : {})
    }).format(cachedWeather.updatedAt);
    weatherButton.title = `${description} · Updated ${updated}. Rounded coordinates are sent to Open-Meteo for the forecast; click to refresh.`;
    weatherButton.setAttribute("aria-label", `${temperature} degrees, ${description}. Rounded coordinates are sent to Open-Meteo and not saved. Refresh local weather.`);
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
