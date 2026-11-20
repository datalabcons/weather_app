// A trimmed-down copy of a Visual Crossing "timeline" response, used in tests
// so they never call the real weather service.

function hours(dayIndex, baseEpoch) {
  return Array.from({ length: 24 }, (_, h) => ({
    datetime: `${String(h).padStart(2, '0')}:00:00`,
    datetimeEpoch: baseEpoch + dayIndex * 86400 + h * 3600,
    temp: 24 + Math.round(5 * Math.sin((h / 24) * Math.PI)),
    precipprob: h % 6 === 0 ? 40 : 0,
    conditions: 'Partially cloudy',
    icon: h > 6 && h < 19 ? 'partly-cloudy-day' : 'partly-cloudy-night',
  }));
}

function sampleResponse(address = 'Lagos') {
  const base = 1763679600; // a fixed midnight, so tests are repeatable
  return {
    address,
    resolvedAddress: `${address}, Lagos, Nigeria`,
    timezone: 'Africa/Lagos',
    latitude: 6.455,
    longitude: 3.394,
    description: 'Similar temperatures continuing with a chance of rain.',
    currentConditions: {
      datetime: '14:00:00',
      datetimeEpoch: base + 14 * 3600,
      temp: 31.2,
      feelslike: 36.4,
      humidity: 70,
      dew: 25,
      windspeed: 14,
      windgust: 22,
      winddir: 220,
      pressure: 1010,
      visibility: 10,
      cloudcover: 45,
      uvindex: 7,
      precipprob: 20,
      conditions: 'Partially cloudy',
      icon: 'partly-cloudy-day',
      sunrise: '06:42:00',
      sunset: '18:35:00',
    },
    days: Array.from({ length: 8 }, (_, i) => ({
      datetime: `2026-11-${String(21 + i).padStart(2, '0')}`,
      tempmax: 32 + (i % 3),
      tempmin: 24 - (i % 2),
      temp: 28,
      precipprob: i * 10,
      conditions: 'Rain, Partially cloudy',
      description: 'Partly cloudy throughout the day with a chance of rain.',
      icon: i % 2 ? 'rain' : 'partly-cloudy-day',
      sunrise: '06:42:00',
      sunset: '18:35:00',
      uvindex: 8,
      windspeed: 15,
      humidity: 72,
      hours: hours(i, base),
    })),
  };
}

module.exports = { sampleResponse };
