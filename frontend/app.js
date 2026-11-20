// Skycast frontend: talks only to our own Weather API (/api/weather).

(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const els = {
    form: $('#search-form'),
    input: $('#search-input'),
    locateBtn: $('#locate-btn'),
    unitButtons: document.querySelectorAll('.unit-toggle button'),
    favorites: $('#favorites'),
    recents: $('#recents'),
    empty: $('#empty-state'),
    loading: $('#loading'),
    error: $('#error'),
    errorEmoji: $('#error-emoji'),
    errorTitle: $('#error-title'),
    errorMessage: $('#error-message'),
    retryBtn: $('#retry-btn'),
    weather: $('#weather'),
    placeName: $('#place-name'),
    favBtn: $('#fav-btn'),
    localTime: $('#local-time'),
    currentIcon: $('#current-icon'),
    currentTemp: $('#current-temp'),
    currentConditions: $('#current-conditions'),
    currentFeels: $('#current-feels'),
    summary: $('#summary'),
    cacheBadge: $('#cache-badge'),
    details: $('#details'),
    hourly: $('#hourly'),
    daily: $('#daily'),
    apiUrl: $('#api-url'),
    copyUrl: $('#copy-url'),
    rawJson: $('#raw-json'),
    toast: $('#toast'),
  };

  /* ---------------- Local storage (wrapped: can fail in private mode) ---------------- */

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    },
  };

  const state = {
    unit: store.get('skycast:unit', 'metric'),
    favorites: store.get('skycast:favorites', []),
    recents: store.get('skycast:recents', []),
    lastQuery: null,
    data: null,
  };

  /* ---------------- Helpers ---------------- */

  const ICONS = {
    'clear-day': '☀️',
    'clear-night': '🌙',
    'partly-cloudy-day': '⛅',
    'partly-cloudy-night': '☁️',
    cloudy: '☁️',
    fog: '🌫️',
    wind: '💨',
    rain: '🌧️',
    'showers-day': '🌦️',
    'showers-night': '🌧️',
    'thunder-rain': '⛈️',
    'thunder-showers-day': '⛈️',
    'thunder-showers-night': '⛈️',
    snow: '❄️',
    'snow-showers-day': '🌨️',
    'snow-showers-night': '🌨️',
    sleet: '🌨️',
    hail: '🌨️',
  };
  const iconFor = (name) => ICONS[name] || '🌡️';

  function themeFor(icon = '') {
    if (icon.includes('thunder')) return 'storm';
    if (icon.includes('snow') || icon === 'sleet' || icon === 'hail') return 'snow';
    if (icon.includes('rain') || icon.includes('showers')) return 'rain';
    if (icon === 'fog') return 'fog';
    if (icon.includes('night')) return 'night';
    if (icon === 'cloudy' || icon === 'wind') return 'cloudy';
    if (icon.includes('clear') || icon.includes('partly')) return 'clear';
    return 'default';
  }

  const round = (n) => (n === null || n === undefined || Number.isNaN(n) ? '–' : Math.round(n));

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
      else node.setAttribute(k, v);
    });
    [].concat(children).forEach((c) => {
      if (c === null || c === undefined) return;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  // "14:00:00" -> "2 PM"
  function formatHour(hms) {
    const h = Number(String(hms).slice(0, 2));
    if (Number.isNaN(h)) return hms;
    const suffix = h < 12 ? 'AM' : 'PM';
    return `${h % 12 === 0 ? 12 : h % 12} ${suffix}`;
  }

  // "06:42:10" -> "6:42 AM"
  function formatClock(hms) {
    if (!hms) return '–';
    const [hStr, m] = String(hms).split(':');
    const h = Number(hStr);
    return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
  }

  function dayName(dateStr, index) {
    if (index === 0) return 'Today';
    if (index === 1) return 'Tomorrow';
    const d = new Date(`${dateStr}T12:00:00Z`);
    return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  function compass(deg) {
    if (deg === null || deg === undefined) return '';
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  function uvLabel(uv) {
    if (uv <= 2) return 'Low';
    if (uv <= 5) return 'Moderate';
    if (uv <= 7) return 'High';
    if (uv <= 10) return 'Very high';
    return 'Extreme';
  }

  function humanDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.round(seconds / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function timeAgo(iso) {
    const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 60) return 'just now';
    return `${humanDuration(secs)} ago`;
  }

  let toastTimer;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
  }

  function show(section) {
    ['empty', 'loading', 'error', 'weather'].forEach((name) =>
      els[name].classList.toggle('hidden', name !== section)
    );
  }

  /* ---------------- Favorites & recents ---------------- */

  const sameCity = (a, b) => a.toLowerCase() === b.toLowerCase();

  function addRecent(label) {
    state.recents = [label, ...state.recents.filter((r) => !sameCity(r, label))].slice(0, 6);
    store.set('skycast:recents', state.recents);
    renderChips();
  }

  function toggleFavorite(label) {
    const exists = state.favorites.some((f) => sameCity(f, label));
    state.favorites = exists
      ? state.favorites.filter((f) => !sameCity(f, label))
      : [...state.favorites, label].slice(-8);
    store.set('skycast:favorites', state.favorites);
    renderChips();
    updateFavButton();
    toast(exists ? `Removed ${label} from favourites` : `⭐ Saved ${label}`);
  }

  function updateFavButton() {
    if (!state.data) return;
    const label = shortName(state.data);
    const fav = state.favorites.some((f) => sameCity(f, label));
    els.favBtn.textContent = fav ? '★' : '☆';
    els.favBtn.setAttribute('aria-pressed', String(fav));
    els.favBtn.title = fav ? 'Remove from favourites' : 'Save to favourites';
  }

  function chipGroup(container, label, items, { removable }) {
    container.replaceChildren();
    if (!items.length) return;
    container.append(el('span', { class: 'chips-label', text: label }));
    items.forEach((city) => {
      const chip = el('button', { class: 'chip', type: 'button', 'data-city': city }, [city]);
      if (removable) {
        const x = el('span', { class: 'x', 'data-remove': city, 'aria-label': `Remove ${city}`, text: '×' });
        chip.append(x);
      }
      container.append(chip);
    });
  }

  function renderChips() {
    chipGroup(els.favorites, '★ Favourites', state.favorites, { removable: true });
    const recentsOnly = state.recents.filter((r) => !state.favorites.some((f) => sameCity(f, r)));
    chipGroup(els.recents, 'Recent', recentsOnly, { removable: false });
  }

  // "Lagos, Lagos, Nigeria" -> "Lagos"; coordinates stay as they are
  function shortName(data) {
    const resolved = data.location.resolvedAddress || data.location.query || '';
    if (/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/.test(resolved)) return resolved;
    return resolved.split(',')[0].trim();
  }

  /* ---------------- Rendering ---------------- */

  function detailCard(label, value, sub, extra) {
    return el('div', { class: 'panel detail' }, [
      el('div', { class: 'label', text: label }),
      el('div', { class: 'value' }, [].concat(value)),
      sub ? el('div', { class: 'sub', text: sub }) : null,
      extra || null,
    ]);
  }

  function meter(percent) {
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    return el('div', { class: 'meter' }, [el('span', { style: `width:${p}%` })]);
  }

  function render(data) {
    const { current: c, units: u } = data;

    document.body.dataset.theme = themeFor(c.icon);

    els.placeName.textContent = data.location.resolvedAddress;
    els.localTime.textContent = localTimeText(data.location.timezone);
    els.currentIcon.textContent = iconFor(c.icon);
    els.currentTemp.textContent = `${round(c.temp)}${u.temp}`;
    els.currentConditions.textContent = c.conditions || '';
    const today = data.daily[0] || {};
    els.currentFeels.textContent =
      `Feels like ${round(c.feelsLike)}° · H ${round(today.tempMax)}° · L ${round(today.tempMin)}°`;
    els.summary.textContent = data.summary;
    updateFavButton();
    renderCacheBadge(data.meta);

    // Details grid
    const windArrow = el('span', {
      class: 'wind-arrow',
      // winddir is where wind comes FROM; arrow points where it's going
      style: `transform: rotate(${(c.windDir || 0) + 180}deg)`,
      'aria-hidden': 'true',
      text: '↑',
    });
    els.details.replaceChildren(
      detailCard('Humidity', `${round(c.humidity)}%`, `Dew point ${round(c.dewPoint)}°`, meter(c.humidity)),
      detailCard(
        'Wind',
        [`${round(c.windSpeed)} ${u.speed}`, windArrow],
        `${compass(c.windDir)}${c.windGust ? ` · gusts ${round(c.windGust)} ${u.speed}` : ''}`
      ),
      detailCard('Chance of rain', `${round(c.precipProb)}%`, 'Today', meter(c.precipProb)),
      detailCard('UV index', `${round(c.uvIndex)}`, uvLabel(c.uvIndex || 0), meter(((c.uvIndex || 0) / 11) * 100)),
      detailCard('Sunrise', formatClock(c.sunrise), `Sunset ${formatClock(c.sunset)}`),
      detailCard('Pressure', `${round(c.pressure)} ${u.pressure}`, c.pressure > 1013 ? 'Higher than average' : 'Lower than average'),
      detailCard('Visibility', `${round(c.visibility)} ${u.distance}`, c.visibility >= 10 ? 'Clear view' : 'Reduced'),
      detailCard('Cloud cover', `${round(c.cloudCover)}%`, c.conditions || '', meter(c.cloudCover))
    );

    // Hourly
    els.hourly.replaceChildren(
      ...data.hourly.map((h, i) =>
        el('div', { class: `hour${i === 0 ? ' now' : ''}` }, [
          el('div', { class: 't', text: i === 0 ? 'Now' : formatHour(h.time) }),
          el('div', { class: 'i', text: iconFor(h.icon), title: h.conditions || '' }),
          el('div', { class: 'temp', text: `${round(h.temp)}°` }),
          el('div', { class: 'p', text: h.precipProb >= 10 ? `💧${round(h.precipProb)}%` : '' }),
        ])
      )
    );

    // Daily with temperature range bars on a shared scale
    const mins = data.daily.map((d) => d.tempMin);
    const maxs = data.daily.map((d) => d.tempMax);
    const lo = Math.min(...mins);
    const hi = Math.max(...maxs);
    const span = hi - lo || 1;
    els.daily.replaceChildren(
      ...data.daily.map((d, i) => {
        const left = ((d.tempMin - lo) / span) * 100;
        const width = Math.max(4, ((d.tempMax - d.tempMin) / span) * 100);
        return el('div', { class: 'day', title: d.description || d.conditions }, [
          el('div', {}, [
            el('div', { class: 'name', text: dayName(d.date, i) }),
            el('div', { class: 'p', text: `💧 ${round(d.precipProb)}%` }),
          ]),
          el('div', { class: 'i', text: iconFor(d.icon) }),
          el('div', { class: 'p', text: d.conditions }),
          el('div', { class: 'range' }, [
            el('span', { class: 'lo', text: `${round(d.tempMin)}°` }),
            el('div', { class: 'bar' }, [el('span', { style: `left:${left}%;width:${width}%` })]),
            el('span', { class: 'hi', text: `${round(d.tempMax)}°` }),
          ]),
        ]);
      })
    );

    els.rawJson.textContent = JSON.stringify(data, null, 2);
    show('weather');
  }

  function renderCacheBadge(meta) {
    const hit = meta.source === 'cache';
    els.cacheBadge.className = `cache-badge ${hit ? 'hit' : 'miss'}`;
    els.cacheBadge.replaceChildren(
      el('strong', { text: hit ? '⚡ Served from cache' : '🌐 Fresh from weather service' }),
      el('span', {
        text: `${hit ? `Fetched ${timeAgo(meta.cachedAt)}` : 'Just fetched'} · refreshes in ${humanDuration(
          meta.expiresInSeconds
        )}`,
      }),
      el('span', { class: 'muted', text: `Response in ${meta.responseMs} ms · ${meta.cacheType} cache` })
    );
  }

  function localTimeText(timeZone) {
    try {
      return new Date().toLocaleString('en-US', {
        timeZone,
        weekday: 'long',
        hour: 'numeric',
        minute: '2-digit',
      }) + ' local time';
    } catch {
      return '';
    }
  }

  const ERROR_UI = {
    LOCATION_NOT_FOUND: ['🔍', 'Place not found'],
    RATE_LIMITED: ['⏳', 'Slow down a little'],
    UPSTREAM_TIMEOUT: ['🐢', 'Weather service is slow'],
    UPSTREAM_UNREACHABLE: ['📡', "Can't reach the weather service"],
    UPSTREAM_LIMIT: ['🚦', 'Weather service is busy'],
    OFFLINE: ['📴', "You're offline"],
  };

  function showError(code, message) {
    const [emoji, title] = ERROR_UI[code] || ['⚠️', 'Something went wrong'];
    els.errorEmoji.textContent = emoji;
    els.errorTitle.textContent = title;
    els.errorMessage.textContent = message;
    document.body.dataset.theme = 'default';
    show('error');
  }

  /* ---------------- Data loading ---------------- */

  let inflight;

  async function loadWeather(query, { remember = true } = {}) {
    const location = String(query || '').trim();
    if (!location) return;

    state.lastQuery = location;
    els.input.value = /^-?\d/.test(location) ? '' : location;
    show('loading');

    const params = new URLSearchParams({ location, unit: state.unit });
    const apiPath = `/api/weather?${params}`;
    history.replaceState(null, '', `?${new URLSearchParams({ q: location, unit: state.unit })}`);

    if (inflight) inflight.abort();
    inflight = new AbortController();

    const started = performance.now();
    try {
      const res = await fetch(apiPath, { signal: inflight.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = body.error || {};
        return showError(err.code, err.message || `Request failed (${res.status}).`);
      }
      body.meta.responseMs = Math.round(performance.now() - started);
      state.data = body;
      els.apiUrl.textContent = `${window.location.origin}${apiPath}`;
      render(body);
      if (remember) addRecent(shortName(body));
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!navigator.onLine) return showError('OFFLINE', 'Check your internet connection and try again.');
      showError('', 'Could not reach the server. Please try again.');
    }
  }

  /* ---------------- Events ---------------- */

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadWeather(els.input.value);
  });

  document.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      e.stopPropagation();
      toggleFavorite(remove.dataset.remove);
      return;
    }
    const chip = e.target.closest('[data-city]');
    if (chip) loadWeather(chip.dataset.city);
  });

  els.unitButtons.forEach((btn) =>
    btn.addEventListener('click', () => {
      if (state.unit === btn.dataset.unit) return;
      state.unit = btn.dataset.unit;
      store.set('skycast:unit', state.unit);
      syncUnitButtons();
      if (state.lastQuery) loadWeather(state.lastQuery, { remember: false });
    })
  );

  function syncUnitButtons() {
    els.unitButtons.forEach((b) => {
      const active = b.dataset.unit === state.unit;
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
    });
  }

  els.favBtn.addEventListener('click', () => state.data && toggleFavorite(shortName(state.data)));
  els.retryBtn.addEventListener('click', () => (state.lastQuery ? loadWeather(state.lastQuery) : show('empty')));

  els.locateBtn.addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Location is not supported in this browser');
    toast('📍 Finding your location…');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => loadWeather(`${coords.latitude.toFixed(4)},${coords.longitude.toFixed(4)}`),
      () => toast('Location permission denied. Search for a city instead.'),
      { timeout: 10000, maximumAge: 10 * 60 * 1000 }
    );
  });

  els.copyUrl.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.apiUrl.textContent);
      toast('API URL copied');
    } catch {
      toast('Could not copy. Select the URL instead.');
    }
  });

  // Keyboard shortcut: "/" focuses the search box
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== els.input) {
      e.preventDefault();
      els.input.focus();
    }
  });

  /* ---------------- Start ---------------- */

  syncUnitButtons();
  renderChips();

  const params = new URLSearchParams(window.location.search);
  if (params.get('unit') === 'us' || params.get('unit') === 'metric') {
    state.unit = params.get('unit');
    syncUnitButtons();
  }
  const initial = params.get('q') || state.favorites[0];
  if (initial) loadWeather(initial, { remember: false });
  else show('empty');
})();
