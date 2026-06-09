const lastUpdateEl = document.getElementById("last-update");
const lastUpdateMetaEl = document.getElementById("last-update-meta");
const signalDetailsEl = document.getElementById("signal-details");
const fwVersionEl = document.getElementById("fw-version");
const heroLevelEl = document.getElementById("hero-level");
const heroLitersEl = document.getElementById("hero-liters");
const heroDaysEl = document.getElementById("hero-days");
const heroSensorEl = document.getElementById("hero-sensor");
const heroOccupancyEl = document.getElementById("hero-occupancy");
const heroBookingEl = document.getElementById("hero-booking");
const signalBadgeEl = document.getElementById("signal-badge");

const REFRESH_INTERVAL_MS = 60 * 1000;

// Populated from GET /api/config on init; defaults keep the dashboard usable
// if that fetch fails. Keep keys aligned with server's get_public_config().
let serverConfig = {
  tank_capacity_liters: 30000,
  tank_depth_cm: 250,
  sensor_to_water_full_cm: 17,
  sensor_to_bottom_cm: 267,
  condensation_error_cm: 13,
  stale_reading_hours: 6,
};

async function fetchConfig() {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return;
    const data = await r.json();
    serverConfig = { ...serverConfig, ...data };
  } catch (err) {
    // Keep defaults.
  }
}

let historyChart = null;
let feedinChart = null;
let currentRange = { type: "preset", value: "1w" };

async function fetchLatest() {
  const response = await fetch("/api/latest");
  return await response.json();
}

async function fetchFeedinRate() {
  try {
    const response = await fetch("/api/feedin-rate?days=7");
    const payload = await response.json();
    return payload.flowrate_lph;
  } catch (err) {
    return null;
  }
}

async function fetchDailyFeedinRates() {
  try {
    const response = await fetch("/api/feedin-rate/daily?days=30");
    const payload = await response.json();
    return payload.daily_rates || [];
  } catch (err) {
    return [];
  }
}

async function fetchUsageAnalysis() {
  try {
    const response = await fetch("/api/usage-analysis?days=7");
    const payload = await response.json();
    if (payload.error) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

async function fetchUpcomingBookings(days = 90) {
  try {
    const response = await fetch(`/api/bookings/upcoming?days=${days}`);
    if (!response.ok) return [];
    const payload = await response.json();
    return payload.bookings || [];
  } catch (err) {
    return [];
  }
}

// "14 Jun – 21 Jun" (same year as today) or "28 Dec 2026 – 5 Jan 2027" (otherwise).
function formatBookingDateRange(startIso, endIso) {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const now = new Date();
  const shortFmt = { day: "numeric", month: "short" };
  const longFmt = { day: "numeric", month: "short", year: "numeric" };
  const sShort = s.toLocaleDateString("en-NZ", shortFmt);
  const eShort = e.toLocaleDateString("en-NZ", shortFmt);
  const sameYearAsNow = s.getFullYear() === now.getFullYear() && e.getFullYear() === now.getFullYear();
  if (sameYearAsNow) return `${sShort} – ${eShort}`;
  return `${s.toLocaleDateString("en-NZ", longFmt)} – ${e.toLocaleDateString("en-NZ", longFmt)}`;
}

function renderBooking(bookings) {
  if (!heroBookingEl) return;
  if (!bookings || bookings.length === 0) {
    heroBookingEl.textContent = "";
    heroBookingEl.className = "hero-booking";
    return;
  }
  const now = Date.now();
  // bookings are oldest-first; current booking is the one whose window contains now.
  const current = bookings.find(
    (b) => new Date(b.start_ts).getTime() <= now && new Date(b.end_ts).getTime() > now
  );
  if (current) {
    heroBookingEl.textContent = `📅 Booked: ${formatBookingDateRange(current.start_ts, current.end_ts)}`;
    heroBookingEl.className = "hero-booking is-booked";
    return;
  }
  const next = bookings.find((b) => new Date(b.start_ts).getTime() > now);
  if (!next) {
    heroBookingEl.textContent = "";
    heroBookingEl.className = "hero-booking";
    return;
  }
  const daysAway = Math.ceil((new Date(next.start_ts).getTime() - now) / 86_400_000);
  const range = formatBookingDateRange(next.start_ts, next.end_ts);
  const daysLabel = daysAway === 1 ? "1 day" : `${daysAway} days`;
  heroBookingEl.textContent = `📅 Next: ${range} (in ${daysLabel})`;
  heroBookingEl.className = "hero-booking is-upcoming";
}

async function fetchReadings(since = null, limit = 10080) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (since != null) {
    params.set("since", new Date(since).toISOString());
  }
  const response = await fetch(`/api/readings?${params}`);
  const payload = await response.json();
  return payload.readings || [];
}

function getRangeWindow(range) {
  if (!range) return null;
  const now = Date.now();
  if (range.type === "preset") {
    switch (range.value) {
      case "1d":
        return { min: now - 24 * 60 * 60 * 1000, max: now };
      case "1w":
        return { min: now - 7 * 24 * 60 * 60 * 1000, max: now };
      case "1m":
        return { min: now - 30 * 24 * 60 * 60 * 1000, max: now };
      case "1y":
        return { min: now - 365 * 24 * 60 * 60 * 1000, max: now };
      case "all":
        return null;
      default:
        return null;
    }
  }
  if (range.type === "custom") {
    const value = range.value;
    const unit = range.unit;
    const unitMs = {
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
      months: 30 * 24 * 60 * 60 * 1000,
      years: 365 * 24 * 60 * 60 * 1000,
    };
    const ms = value * (unitMs[unit] || 0);
    if (!ms) return null;
    return { min: now - ms, max: now };
  }
  return null;
}

function getTimeUnit(window) {
  if (!window) return "month";
  const rangeMs = window.max - window.min;
  const dayMs = 24 * 60 * 60 * 1000;
  if (rangeMs <= 2 * dayMs) return "hour";
  if (rangeMs <= 14 * dayMs) return "day";
  if (rangeMs <= 90 * dayMs) return "week";
  if (rangeMs <= 400 * dayMs) return "month";
  return "year";
}


function setActiveRangeButton(range) {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.classList.toggle(
      "active",
      range.type === "preset" && btn.dataset.range === range.value
    );
  });
  const presetSelect = document.getElementById("preset-range-select");
  if (presetSelect && range.type === "preset") {
    presetSelect.value = range.value;
  }
}

function formatPercent(value) {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)}%`;
}

function formatDistance(value) {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(1)} cm`;
}

function formatSignal(value, unit) {
  if (value === null || value === undefined) return "—";
  return `${value} ${unit}`;
}

// Fallback estimator only used if /api/usage-analysis returns insufficient-data.
// The server's analysis is the source of truth when available.
function estimateDaysRemainingFromLatest(reading, fallbackDailyLiters = 390) {
  if (!reading || reading.level_percent === null || reading.level_percent === undefined) {
    return null;
  }
  const litersRemaining = (reading.level_percent / 100) * serverConfig.tank_capacity_liters;
  if (litersRemaining <= 0) return 0;
  return litersRemaining / fallbackDailyLiters;
}

function toSignalQuality(rsrp) {
  if (rsrp === null || rsrp === undefined) return "—";
  if (rsrp >= -90) return "Great";
  if (rsrp >= -100) return "Good";
  if (rsrp >= -110) return "Average";
  if (rsrp >= -120) return "Poor";
  return "Terrible";
}

function getSignalBadge(rsrp) {
  const quality = toSignalQuality(rsrp);
  if (quality === "Great" || quality === "Good") {
    return { text: quality, className: "badge good" };
  }
  if (quality === "Average") {
    return { text: quality, className: "badge ok" };
  }
  if (quality === "Poor") {
    return { text: quality, className: "badge warn" };
  }
  if (quality === "Terrible") {
    return { text: quality, className: "badge bad" };
  }
  return { text: "—", className: "badge" };
}

function getLevelStatus(levelPercent) {
  if (levelPercent === null || levelPercent === undefined) {
    return { text: "Level unknown", className: "badge" };
  }
  if (levelPercent > 60) return { text: "✅ Plenty of water", className: "badge good" };
  if (levelPercent >= 30) return { text: "⚠️ Monitor usage", className: "badge warn" };
  return { text: "🚨 Low – consider refilling", className: "badge bad" };
}

function formatTimeAgo(ts) {
  const t = ts instanceof Date ? ts : new Date(ts);
  const secondsAgo = Math.floor((Date.now() - t.getTime()) / 1000);
  const minutesAgo = Math.floor(secondsAgo / 60);
  const hoursAgo = Math.floor(minutesAgo / 60);
  const daysAgo = Math.floor(hoursAgo / 24);
  if (daysAgo > 0) return `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`;
  if (hoursAgo > 0) return `${hoursAgo} hour${hoursAgo === 1 ? "" : "s"} ago`;
  if (minutesAgo > 0) return `${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago`;
  if (secondsAgo > 5) return `${secondsAgo} seconds ago`;
  return "just now";
}

// "10 hours ago" -> "for 10 hours". Returns "just now" unchanged.
function formatDurationFor(ts) {
  const ago = formatTimeAgo(ts);
  if (ago === "just now") return ago;
  return "for " + ago.replace(/ ago$/, "");
}

function renderLatest(payload) {
  const reading = payload.reading;
  if (!reading) {
    lastUpdateEl.textContent = "—";
    lastUpdateMetaEl.textContent = "—";
    heroLevelEl.textContent = "—";
    heroLitersEl.textContent = "—";
    heroDaysEl.textContent = "—";
    if (heroSensorEl) {
      heroSensorEl.textContent = "—";
      heroSensorEl.className = "hero-sensor";
    }
    return;
  }
  const sensorError = payload.sensor_error === true;
  const displayReading =
    sensorError && payload.last_good_reading ? payload.last_good_reading : reading;
  const ts = new Date(reading.ts);
  const agoText = formatTimeAgo(ts);
  lastUpdateEl.textContent = `${ts.toLocaleString()} (${agoText})`;
  lastUpdateMetaEl.textContent = `Distance: ${formatDistance(reading.distance_cm)} · Level: ${formatPercent(
    reading.level_percent
  )}`;
  signalDetailsEl.textContent = `RSRP: ${formatSignal(reading.signal_rsrp, "dBm")}`;
  fwVersionEl.textContent = reading.fw_version != null && reading.fw_version !== ""
    ? `Firmware: v${reading.fw_version}`
    : "Firmware: —";

  const levelUnknown =
    displayReading.level_percent === null ||
    displayReading.level_percent === undefined ||
    (sensorError && !payload.last_good_reading);
  const levelText = formatPercent(displayReading.level_percent);
  heroLevelEl.textContent = levelUnknown ? "Level unknown" : `${levelText} Full`;
  if (levelUnknown) {
    heroLitersEl.textContent = "";
    heroDaysEl.textContent = "";
  } else {
    const litersRemaining = (displayReading.level_percent / 100) * serverConfig.tank_capacity_liters;
    heroLitersEl.textContent = `≈ ${Math.round(litersRemaining).toLocaleString()} L remaining`;
    heroDaysEl.textContent = ""; // Will be updated by updateDashboard with usage analysis
  }

  if (signalBadgeEl) {
    const signal = getSignalBadge(reading.signal_rsrp);
    signalBadgeEl.textContent = `Signal: ${signal.text}`;
    signalBadgeEl.className = signal.className;
  }
  if (heroSensorEl) {
    if (sensorError) {
      heroSensorEl.textContent = payload.last_good_reading
        ? `❌ error: ${formatDurationFor(payload.last_good_reading.ts)}`
        : "❌ sensor error";
      heroSensorEl.className = "hero-sensor is-error";
    } else {
      heroSensorEl.textContent = `Sensor updated: ${agoText}`;
      heroSensorEl.className = "hero-sensor";
    }
  }
  if (heroOccupancyEl) {
    const occ = payload.occupancy;
    if (!occ || occ.state === "unknown" || !occ.state) {
      heroOccupancyEl.textContent = "";
      heroOccupancyEl.className = "hero-occupancy";
    } else if (occ.state === "occupied") {
      const since = occ.last_change_ts ? `: ${formatDurationFor(occ.last_change_ts)}` : "";
      heroOccupancyEl.textContent = `🏠 occupied${since}`;
      heroOccupancyEl.className = "hero-occupancy is-occupied";
    } else {
      const since = occ.last_change_ts ? `: ${formatDurationFor(occ.last_change_ts)}` : "";
      heroOccupancyEl.textContent = `🏠 unoccupied${since}`;
      heroOccupancyEl.className = "hero-occupancy is-unoccupied";
    }
  }
}


const historyLevelFillPlugin = {
  id: "historyLevelFill",
  beforeDatasetDraw(chart, args) {
    if (chart.canvas.id !== "historyChart" || args.index !== 0) return;
    const meta = chart.getDatasetMeta(0);
    const data = chart.data.datasets[0].data;
    if (!meta.data.length || !data.length) return;
    const yScale = chart.scales.yPercent;
    const y0 = yScale.getPixelForValue(0);
    const ctx = chart.ctx;
    const ca = chart.chartArea;
    // Clip to the chart plot area so fills don't leak into axis label space.
    ctx.save();
    ctx.beginPath();
    ctx.rect(ca.left, ca.top, ca.right - ca.left, ca.bottom - ca.top);
    ctx.clip();
    for (let i = 0; i < meta.data.length - 1; i++) {
      const p0 = meta.data[i];
      const p1 = meta.data[i + 1];
      const raw0 = data[i];
      const raw1 = data[i + 1];
      const isError =
        (raw0 && raw0.condensation_error) || (raw1 && raw1.condensation_error);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p1.x, y0);
      ctx.lineTo(p0.x, y0);
      ctx.closePath();
      ctx.fillStyle = isError ? "rgba(220, 38, 38, 0.25)" : "rgba(79, 70, 229, 0.25)";
      ctx.fill();
    }
    ctx.restore();
  },
};
if (typeof Chart !== "undefined") Chart.register(historyLevelFillPlugin);

function renderChart(readings) {
  const dataPercent = readings.map((r) => ({
    x: new Date(r.ts).getTime(),
    y: r.level_percent,
    condensation_error: r.distance_cm != null && r.distance_cm < serverConfig.condensation_error_cm,
  }));
  const dataDistance = readings.map((r) => ({
    x: new Date(r.ts).getTime(),
    y: r.distance_cm,
    condensation_error: r.distance_cm != null && r.distance_cm < serverConfig.condensation_error_cm,
  }));

  const ctx = document.getElementById("historyChart").getContext("2d");
  const window = getRangeWindow(currentRange);
  const timeUnit = getTimeUnit(window);
  return new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Level (%)",
          data: dataPercent,
          borderColor: "#4f46e5",
          tension: 0.2,
          spanGaps: true,
          yAxisID: "yPercent",
          fill: false,
          pointRadius: (ctx) => (ctx.raw.condensation_error ? 4 : 0),
          pointBackgroundColor: (ctx) =>
            ctx.raw.condensation_error ? "#dc2626" : "#4f46e5",
          pointBorderColor: (ctx) =>
            ctx.raw.condensation_error ? "#b91c1c" : "#4f46e5",
          pointBorderWidth: 1,
        },
        {
          label: "Distance (cm)",
          data: dataDistance,
          borderColor: "#16a34a",
          backgroundColor: "rgba(22, 163, 74, 0.2)",
          tension: 0.2,
          spanGaps: true,
          yAxisID: "yDistance",
          hidden: true, // Hidden by default
          pointRadius: (ctx) => (ctx.raw.condensation_error ? 4 : 0),
          pointBackgroundColor: (ctx) =>
            ctx.raw.condensation_error ? "#dc2626" : "#16a34a",
          pointBorderColor: (ctx) =>
            ctx.raw.condensation_error ? "#b91c1c" : "#16a34a",
          pointBorderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          onClick: (e, legendItem, legend) => {
            // Allow toggling datasets via legend clicks
            const index = legendItem.datasetIndex;
            const chart = legend.chart;
            const meta = chart.getDatasetMeta(index);
            meta.hidden = meta.hidden === null ? !chart.data.datasets[index].hidden : null;
            chart.update();
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            unit: timeUnit,
            tooltipFormat: "PPpp",
            displayFormats: {
              hour: "ha",
              day: "MMM d",
              week: "MMM d",
              month: "MMM yyyy",
              year: "yyyy",
            },
          },
          min: window ? window.min : undefined,
          max: window ? window.max : undefined,
          title: { display: true, text: "Time" },
        },
        yPercent: {
          type: "linear",
          position: "left",
          min: 0,
          max: 100,
          title: { display: true, text: "Level (%)" },
        },
        yDistance: {
          type: "linear",
          position: "right",
          min: 0,
          // Just past SENSOR_TO_BOTTOM_CM (267) so the empty tank fits.
          max: 300,
          title: { display: true, text: "Distance (cm)" },
          grid: { drawOnChartArea: false },
        },
      },
    },
  });
}

function updateChart(chart, readings) {
  const dataPercent = readings.map((r) => ({
    x: new Date(r.ts).getTime(),
    y: r.level_percent,
    condensation_error: r.distance_cm != null && r.distance_cm < serverConfig.condensation_error_cm,
  }));
  const dataDistance = readings.map((r) => ({
    x: new Date(r.ts).getTime(),
    y: r.distance_cm,
    condensation_error: r.distance_cm != null && r.distance_cm < serverConfig.condensation_error_cm,
  }));
  const window = getRangeWindow(currentRange);
  const timeUnit = getTimeUnit(window);
  chart.data.datasets[0].data = dataPercent;
  chart.data.datasets[1].data = dataDistance;
  // Preserve the hidden state from legend clicks (meta.hidden can be true, false, or null)
  const distanceMeta = chart.getDatasetMeta(1);
  if (distanceMeta && chart.data.datasets[1]) {
    chart.data.datasets[1].hidden = distanceMeta.hidden !== false;
  }
  chart.options.scales.x.min = window ? window.min : undefined;
  chart.options.scales.x.max = window ? window.max : undefined;
  chart.options.scales.x.time.unit = timeUnit;
  chart.options.scales.x.time.displayFormats.hour = "ha";
  chart.update();
}

const feedinFullLabelPlugin = {
  id: "feedinFullLabel",
  afterDatasetsDraw(chart) {
    if (chart.canvas.id !== "feedinChart") return;
    const ds = chart.data.datasets[0];
    if (!ds || !ds.data.length) return;
    const meta = chart.getDatasetMeta(0);
    const ctx = chart.ctx;
    meta.data.forEach((point, i) => {
      const raw = ds.data[i];
      if (!raw || point.skip === true) return;
      const isError = raw.condensation_error;
      const isFull = raw.reached_full && !isError;
      if (!isError && !isFull) return;
      const x = point.x;
      const y = point.y - 22;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 2);
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = isError ? "#dc2626" : "#22c55e";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(isError ? "error" : "full", 0, 0);
      ctx.restore();
    });
  },
};
if (typeof Chart !== "undefined") Chart.register(feedinFullLabelPlugin);

function renderFeedinChart(dailyRates, feedinRate) {
  const ctx = document.getElementById("feedinChart").getContext("2d");
  
  if (dailyRates.length === 0) {
    // Create empty chart with message
    return new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          {
            label: "Feed-in Rate (L/hour)",
            data: [],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            enabled: false,
          },
        },
        scales: {
          x: {
            type: "time",
            time: {
              unit: "day",
            },
            title: { display: true, text: "Date" },
          },
          y: {
            title: { display: true, text: "Flow Rate (L/hour)" },
            beginAtZero: true,
          },
        },
      },
    });
  }

  const data = dailyRates.map((r) => ({
    x: new Date(r.date + "T00:00:00").getTime(),
    y: Number(r.flowrate_lph) || 0,
    reached_full: r.reached_full ?? false,
    condensation_error: r.condensation_error ?? false,
  }));

  const datasets = [
    {
      label: "Feed-in Rate (L/hour)",
      data: data,
      borderColor: "#3b82f6",
      segment: {
        borderColor: (ctx) => {
          const p0 = ctx.p0?.raw;
          const p1 = ctx.p1?.raw;
          if (p0?.condensation_error && p1?.condensation_error) return "#dc2626";
          if (p0?.reached_full && p1?.reached_full) return "#22c55e";
          return "#3b82f6";
        },
      },
      backgroundColor: "rgba(59, 130, 246, 0.2)",
      borderWidth: 2,
      tension: 0.2,
      fill: true,
      pointRadius: 4,
      pointBackgroundColor: (ctx) =>
        ctx.raw.condensation_error
          ? "#dc2626"
          : ctx.raw.reached_full
            ? "#22c55e"
            : "#3b82f6",
      pointBorderColor: (ctx) =>
        ctx.raw.condensation_error
          ? "#b91c1c"
          : ctx.raw.reached_full
            ? "#16a34a"
            : "#2563eb",
      pointBorderWidth: 1,
    },
  ];

  const numFeedinRate = feedinRate != null ? Number(feedinRate) : NaN;
  if (!isNaN(numFeedinRate) && dailyRates.length > 0) {
    const xMin = new Date(dailyRates[0].date + "T00:00:00").getTime();
    const xMax = new Date(dailyRates[dailyRates.length - 1].date + "T00:00:00").getTime();
    datasets.push({
      type: "line",
      label: `7-day average: ${numFeedinRate.toFixed(1)} L/hour`,
      data: [{ x: xMin, y: numFeedinRate }, { x: xMax, y: numFeedinRate }],
      borderColor: "#2563eb",
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
    });
  }

  return new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "time",
          time: {
            unit: "day",
            tooltipFormat: "PP",
            displayFormats: {
              day: "MMM d",
            },
          },
          title: { display: true, text: "Date" },
        },
        y: {
          title: { display: true, text: "Flow Rate (L/hour)" },
          beginAtZero: true,
          suggestedMax: !isNaN(numFeedinRate) && numFeedinRate > 0
            ? Math.max(10, numFeedinRate * 1.2)
            : undefined,
        },
      },
      plugins: {
        legend: {
          display: true,
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              const rate = context.parsed.y;
              if (context.dataset.label && context.dataset.label.startsWith("7-day average")) {
                return `${context.dataset.label}`;
              }
              const dailyRatesEntry = dailyRates.find(
                (r) => new Date(r.date + "T00:00:00").getTime() === context.parsed.x
              );
              if (dailyRatesEntry) {
                const lines = [
                  `Flow Rate: ${rate.toFixed(1)} L/hour`,
                  `Level: ${dailyRatesEntry.level_start.toFixed(1)}% → ${dailyRatesEntry.level_end.toFixed(1)}%`,
                ];
                if (dailyRatesEntry.condensation_error) {
                  lines.push("Sensor error (condensation, <13cm)");
                }
                if (dailyRatesEntry.reached_full) {
                  lines.push("Tank reached 100% during this window");
                }
                return lines;
              }
              return `Flow Rate: ${rate.toFixed(1)} L/hour`;
            },
          },
        },
      },
    },
  });
}

function updateFeedinChart(chart, dailyRates, feedinRate) {
  if (dailyRates.length === 0) {
    chart.data.datasets[0].data = [];
    if (chart.data.datasets.length > 1) chart.data.datasets.pop();
    chart.update();
    return;
  }

  const data = dailyRates.map((r) => ({
    x: new Date(r.date + "T00:00:00").getTime(),
    y: Number(r.flowrate_lph) || 0,
    reached_full: r.reached_full ?? false,
    condensation_error: r.condensation_error ?? false,
  }));

  chart.data.datasets[0].data = data;
  chart.data.datasets[0].pointBackgroundColor = (ctx) =>
    ctx.raw.condensation_error
      ? "#dc2626"
      : ctx.raw.reached_full
        ? "#22c55e"
        : "#3b82f6";
  chart.data.datasets[0].pointBorderColor = (ctx) =>
    ctx.raw.condensation_error
      ? "#b91c1c"
      : ctx.raw.reached_full
        ? "#16a34a"
        : "#2563eb";
  chart.data.datasets[0].segment = {
    borderColor: (ctx) => {
      const p0 = ctx.p0?.raw;
      const p1 = ctx.p1?.raw;
      if (p0?.condensation_error && p1?.condensation_error) return "#dc2626";
      if (p0?.reached_full && p1?.reached_full) return "#22c55e";
      return "#3b82f6";
    },
  };

  const xMin = new Date(dailyRates[0].date + "T00:00:00").getTime();
  const xMax = new Date(dailyRates[dailyRates.length - 1].date + "T00:00:00").getTime();
  const numFeedinRate = feedinRate != null ? Number(feedinRate) : NaN;
  if (chart.options.scales && chart.options.scales.y) {
    chart.options.scales.y.suggestedMax =
      !isNaN(numFeedinRate) && numFeedinRate > 0
        ? Math.max(10, numFeedinRate * 1.2)
        : undefined;
  }
  if (!isNaN(numFeedinRate)) {
    const avgLabel = `7-day average: ${numFeedinRate.toFixed(1)} L/hour`;
    const avgLine = chart.data.datasets.find((d) => d.label && d.label.startsWith("7-day average"));
    const lineData = [{ x: xMin, y: numFeedinRate }, { x: xMax, y: numFeedinRate }];
    if (avgLine) {
      avgLine.data = lineData;
      avgLine.label = avgLabel;
    } else {
      chart.data.datasets.push({
        type: "line",
        label: avgLabel,
        data: lineData,
        borderColor: "#2563eb",
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        fill: false,
      });
    }
  } else if (chart.data.datasets.length > 1) {
    chart.data.datasets.pop();
  }

  chart.update();
}

function updateDaysRemaining(reading, usageAnalysis) {
  if (!reading || reading.level_percent === null || reading.level_percent === undefined) {
    heroDaysEl.textContent = "";
    return;
  }

  const litersRemaining = (reading.level_percent / 100) * serverConfig.tank_capacity_liters;

  if (usageAnalysis && usageAnalysis.net_usage_lpd !== undefined) {
    const netUsage = usageAnalysis.net_usage_lpd;
    const sustainable = usageAnalysis.sustainable;
    const daysUntilEmpty = usageAnalysis.days_until_empty;

    if (sustainable) {
      heroDaysEl.textContent = `✅ Sustainable (feed-in exceeds usage)`;
      heroDaysEl.className = "badge good";
    } else if (daysUntilEmpty !== null && daysUntilEmpty > 60) {
      heroDaysEl.textContent = `✅ Sustainable (>60 days supply)`;
      heroDaysEl.className = "badge good";
    } else if (daysUntilEmpty !== null && daysUntilEmpty > 0) {
      heroDaysEl.textContent = `⚠️ ~${daysUntilEmpty.toFixed(1)} days until empty (at current rate)`;
      heroDaysEl.className = "badge warn";
    } else {
      heroDaysEl.textContent = "⚠️ Usage exceeds feed-in";
      heroDaysEl.className = "badge bad";
    }
  } else {
    const daysRemaining = estimateDaysRemainingFromLatest(reading);
    if (daysRemaining !== null) {
      heroLitersEl.textContent += ` (~${daysRemaining.toFixed(1)} days)`;
    } else {
      heroDaysEl.textContent = "Estimated days remaining pending";
      heroDaysEl.className = "badge";
    }
  }
}

async function updateDashboard() {
  // Pass since= so /api/readings returns only what the chart needs, instead of
  // dragging ALL readings every minute. 'All time' (window=null) falls through
  // to the server's limit cap.
  const window = getRangeWindow(currentRange);
  const since = window ? window.min : null;
  const [latest, readings, feedinRate, dailyRates, usageAnalysis, bookings] = await Promise.all([
    fetchLatest(),
    fetchReadings(since),
    fetchFeedinRate(),
    fetchDailyFeedinRates(),
    fetchUsageAnalysis(),
    fetchUpcomingBookings(),
  ]);
  renderLatest(latest);
  renderBooking(bookings);
  const displayReading =
    latest.sensor_error && latest.last_good_reading
      ? latest.last_good_reading
      : latest.sensor_error
        ? null
        : latest.reading;
  updateDaysRemaining(displayReading, usageAnalysis);
  const hasHistoryError = readings.some(
    (r) => r.distance_cm != null && r.distance_cm < serverConfig.condensation_error_cm
  );
  const hasFeedinError = (dailyRates || []).some((r) => r.condensation_error);
  const historyLegendEl = document.getElementById("history-legend");
  const feedinLegendEl = document.getElementById("feedin-legend");
  if (historyLegendEl) historyLegendEl.style.display = hasHistoryError ? "block" : "none";
  if (feedinLegendEl) feedinLegendEl.style.display = hasFeedinError ? "block" : "none";
  if (!historyChart) {
    historyChart = renderChart(readings);
  } else {
    updateChart(historyChart, readings);
  }
  if (!feedinChart) {
    feedinChart = renderFeedinChart(dailyRates, feedinRate);
  } else {
    updateFeedinChart(feedinChart, dailyRates, feedinRate);
  }
}

async function init() {
  const savedRange = localStorage.getItem("tankRange");
  if (savedRange) {
    try {
      currentRange = JSON.parse(savedRange);
    } catch (err) {
      currentRange = { type: "preset", value: "1w" };
    }
  }
  setActiveRangeButton(currentRange);
  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentRange = { type: "preset", value: btn.dataset.range };
      setActiveRangeButton(currentRange);
      localStorage.setItem("tankRange", JSON.stringify(currentRange));
      updateDashboard();
    });
  });
  document.getElementById("preset-range-select").addEventListener("change", (event) => {
    currentRange = { type: "preset", value: event.target.value };
    setActiveRangeButton(currentRange);
    localStorage.setItem("tankRange", JSON.stringify(currentRange));
    updateDashboard();
  });
  const applyCustomRange = () => {
    const value = parseInt(document.getElementById("custom-range-value").value, 10);
    const unit = document.getElementById("custom-range-unit").value;
    if (!Number.isFinite(value) || value <= 0) {
      return;
    }
    currentRange = { type: "custom", value, unit };
    setActiveRangeButton(currentRange);
    localStorage.setItem("tankRange", JSON.stringify(currentRange));
    updateDashboard();
  };
  document.getElementById("custom-range-apply").addEventListener("click", applyCustomRange);
  document.getElementById("custom-range-unit").addEventListener("change", applyCustomRange);
  document.getElementById("custom-range-value").addEventListener("keyup", (event) => {
    if (event.key === "Enter") {
      applyCustomRange();
    }
  });

  // Fetch server config first so charts + level math use authoritative constants.
  await fetchConfig();
  await updateDashboard();
  setInterval(updateDashboard, REFRESH_INTERVAL_MS);
}

init();

// -----------------------------------------------------------------------------
// Notification preferences — fetch on load, POST on toggle, optimistic update
// with rollback on failure.
// -----------------------------------------------------------------------------
(function initNotifications() {
  const waterEl = document.getElementById('toggle-water-alerts');
  const occEl = document.getElementById('toggle-occupancy');
  const statusEl = document.getElementById('notif-status');
  if (!waterEl || !occEl || !statusEl) return;

  let statusTimer = null;
  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (msg && !isError) {
      statusTimer = setTimeout(() => {
        if (statusEl.textContent === msg) statusEl.textContent = '';
      }, 2000);
    }
  }

  async function load() {
    try {
      const r = await fetch('/api/settings');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      waterEl.checked = !!data.notify_water_alerts;
      occEl.checked = !!data.notify_occupancy;
    } catch (e) {
      setStatus('Could not load settings', true);
    }
  }

  async function save(field, value, sourceEl) {
    setStatus('Saving…', false);
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      // Reflect authoritative server state (handles concurrent edits).
      waterEl.checked = !!data.notify_water_alerts;
      occEl.checked = !!data.notify_occupancy;
      setStatus('Saved', false);
    } catch (e) {
      sourceEl.checked = !value; // roll back optimistic UI
      setStatus('Failed to save — try again', true);
    }
  }

  waterEl.addEventListener('change', () => save('notify_water_alerts', waterEl.checked, waterEl));
  occEl.addEventListener('change', () => save('notify_occupancy', occEl.checked, occEl));

  load();
})();
