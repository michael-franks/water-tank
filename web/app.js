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
let currentRange = { type: "month", offset: 0 };
let currentBlock = null;

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

async function fetchReadings(since = null, until = null, bucket = null, limit = 20000) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (since != null) params.set("since", new Date(since).toISOString());
  if (until != null) params.set("until", new Date(until).toISOString());
  if (bucket && bucket !== "none") params.set("bucket", bucket);
  const response = await fetch(`/api/readings?${params}`);
  const payload = await response.json();
  return payload.readings || [];
}

// Range model: { type: 'day'|'week'|'month'|'year'|'all', offset } where offset is
// whole blocks back from the current one (0 = current). computeBlock turns that
// into a concrete window + a human label + the server downsample bucket + x unit.
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function computeBlock(range) {
  const now = new Date();
  const o = Math.max(0, range.offset || 0);
  const short = { day: "numeric", month: "short" };
  if (range.type === "all") {
    return { min: null, max: now.getTime(), label: "All time", bucket: "week", unit: "month", canStep: false };
  }
  if (range.type === "day") {
    const s = startOfDay(now); s.setDate(s.getDate() - o);
    const e = new Date(s); e.setDate(e.getDate() + 1);
    return {
      min: s.getTime(), max: Math.min(e.getTime(), now.getTime()),
      label: s.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }),
      bucket: "none", unit: "hour", canStep: true,
    };
  }
  if (range.type === "week") {
    const s = startOfDay(now);
    s.setDate(s.getDate() - ((s.getDay() + 6) % 7) - o * 7); // back to Monday, then o weeks
    const e = new Date(s); e.setDate(e.getDate() + 7);
    const eLbl = new Date(e); eLbl.setDate(eLbl.getDate() - 1);
    return {
      min: s.getTime(), max: Math.min(e.getTime(), now.getTime()),
      label: `${s.toLocaleDateString("en-NZ", short)} – ${eLbl.toLocaleDateString("en-NZ", short)}`,
      bucket: "hour", unit: "day", canStep: true,
    };
  }
  if (range.type === "month") {
    const s = new Date(now.getFullYear(), now.getMonth() - o, 1);
    const e = new Date(now.getFullYear(), now.getMonth() - o + 1, 1);
    return {
      min: s.getTime(), max: Math.min(e.getTime(), now.getTime()),
      label: s.toLocaleDateString("en-NZ", { month: "long", year: "numeric" }),
      bucket: "day", unit: "day", canStep: true,
    };
  }
  const s = new Date(now.getFullYear() - o, 0, 1);
  const e = new Date(now.getFullYear() - o + 1, 0, 1);
  return {
    min: s.getTime(), max: Math.min(e.getTime(), now.getTime()),
    label: String(now.getFullYear() - o),
    bucket: "week", unit: "month", canStep: true,
  };
}

function saveRange() {
  try { localStorage.setItem("tankRange2", JSON.stringify(currentRange)); } catch (e) {}
}

function renderRangeControls(block) {
  document.querySelectorAll("#range-pills button").forEach((b) => {
    b.classList.toggle("on", b.dataset.range === currentRange.type);
  });
  const labelEl = document.getElementById("range-label");
  if (labelEl) labelEl.textContent = block.label;
  const stepper = document.getElementById("range-stepper");
  if (stepper) stepper.style.visibility = block.canStep ? "visible" : "hidden";
  const next = document.getElementById("range-next");
  if (next) next.disabled = (currentRange.offset || 0) <= 0;
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


function renderChart(readings) {
  const data = readings.map((r) => ({ x: new Date(r.ts).getTime(), y: r.level_percent }));
  const ctx = document.getElementById("historyChart").getContext("2d");
  const b = currentBlock || {};
  return new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Level",
          data,
          borderColor: "#0ea5e9",
          backgroundColor: "rgba(14,165,233,0.12)",
          borderWidth: 2.5,
          tension: 0.35,
          cubicInterpolationMode: "monotone",
          spanGaps: true,
          fill: "origin",
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: "#0ea5e9",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: { label: (c) => (c.parsed.y == null ? "–" : `${c.parsed.y.toFixed(0)}% full`) },
        },
      },
      scales: {
        x: {
          type: "time",
          time: {
            unit: b.unit || "day",
            tooltipFormat: "PPpp",
            displayFormats: { hour: "ha", day: "d MMM", week: "d MMM", month: "MMM yyyy", year: "yyyy" },
          },
          min: b.min ?? undefined,
          max: b.max ?? undefined,
          grid: { display: false },
          border: { display: false },
          ticks: { maxRotation: 0, autoSkipPadding: 20, color: "#94a3b8" },
        },
        y: {
          type: "linear",
          min: 0,
          max: 100,
          grid: { color: "rgba(15,23,42,0.06)" },
          border: { display: false },
          ticks: { stepSize: 25, callback: (v) => `${v}%`, color: "#94a3b8" },
        },
      },
    },
  });
}

function updateChart(chart, readings) {
  const data = readings.map((r) => ({ x: new Date(r.ts).getTime(), y: r.level_percent }));
  const b = currentBlock || {};
  chart.data.datasets[0].data = data;
  chart.options.scales.x.min = b.min ?? undefined;
  chart.options.scales.x.max = b.max ?? undefined;
  chart.options.scales.x.time.unit = b.unit || "day";
  chart.update();
}

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
      label: "Feed-in",
      data: data,
      borderColor: "#0d9488",
      backgroundColor: "rgba(13,148,136,0.12)",
      borderWidth: 2.5,
      tension: 0.35,
      cubicInterpolationMode: "monotone",
      fill: "origin",
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: "#0d9488",
    },
  ];

  const numFeedinRate = feedinRate != null ? Number(feedinRate) : NaN;
  if (!isNaN(numFeedinRate) && dailyRates.length > 0) {
    const xMin = new Date(dailyRates[0].date + "T00:00:00").getTime();
    const xMax = new Date(dailyRates[dailyRates.length - 1].date + "T00:00:00").getTime();
    datasets.push({
      type: "line",
      label: `avg ${numFeedinRate.toFixed(0)} L/h`,
      data: [{ x: xMin, y: numFeedinRate }, { x: xMax, y: numFeedinRate }],
      borderColor: "#94a3b8",
      borderWidth: 1.5,
      borderDash: [5, 4],
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
          time: { unit: "day", tooltipFormat: "PP", displayFormats: { day: "d MMM" } },
          grid: { display: false },
          border: { display: false },
          ticks: { maxRotation: 0, autoSkipPadding: 20, color: "#94a3b8" },
        },
        y: {
          beginAtZero: true,
          grid: { color: "rgba(15,23,42,0.06)" },
          border: { display: false },
          ticks: { color: "#94a3b8" },
          suggestedMax: !isNaN(numFeedinRate) && numFeedinRate > 0 ? Math.max(10, numFeedinRate * 1.2) : undefined,
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            label: (c) => (c.dataset.label && c.dataset.label.startsWith("avg")) ? c.dataset.label : `${c.parsed.y.toFixed(0)} L/h`,
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
  const numFeedinRate = feedinRate != null ? Number(feedinRate) : NaN;
  const xMin = new Date(dailyRates[0].date + "T00:00:00").getTime();
  const xMax = new Date(dailyRates[dailyRates.length - 1].date + "T00:00:00").getTime();
  if (chart.options.scales && chart.options.scales.y) {
    chart.options.scales.y.suggestedMax =
      !isNaN(numFeedinRate) && numFeedinRate > 0 ? Math.max(10, numFeedinRate * 1.2) : undefined;
  }
  if (!isNaN(numFeedinRate)) {
    const avgLabel = `avg ${numFeedinRate.toFixed(0)} L/h`;
    const avgLine = chart.data.datasets.find((d) => d.label && d.label.startsWith("avg"));
    const lineData = [{ x: xMin, y: numFeedinRate }, { x: xMax, y: numFeedinRate }];
    if (avgLine) {
      avgLine.data = lineData;
      avgLine.label = avgLabel;
    } else {
      chart.data.datasets.push({
        type: "line",
        label: avgLabel,
        data: lineData,
        borderColor: "#94a3b8",
        borderWidth: 1.5,
        borderDash: [5, 4],
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

async function fetchFirmwareStatus() {
  try {
    const r = await fetch("/api/firmware/status");
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    return null;
  }
}

function renderFirmware(status) {
  if (!fwVersionEl || !status) return; // leave whatever renderLatest set
  if (!status.current) {
    fwVersionEl.textContent = "Firmware: —";
    return;
  }
  let text = `Firmware: v${status.current}`;
  if (status.latest && !status.up_to_date) {
    text += ` · update available: v${status.latest}`;
  } else if (status.up_to_date) {
    text += " · up to date";
  }
  fwVersionEl.textContent = text;
}

async function updateDashboard() {
  currentBlock = computeBlock(currentRange);
  renderRangeControls(currentBlock);
  const [latest, readings, feedinRate, dailyRates, usageAnalysis, bookings, firmware] = await Promise.all([
    fetchLatest(),
    fetchReadings(currentBlock.min, currentBlock.max, currentBlock.bucket),
    fetchFeedinRate(),
    fetchDailyFeedinRates(),
    fetchUsageAnalysis(),
    fetchUpcomingBookings(),
    fetchFirmwareStatus(),
  ]);
  renderLatest(latest);
  renderBooking(bookings);
  renderFirmware(firmware);
  const displayReading =
    latest.sensor_error && latest.last_good_reading
      ? latest.last_good_reading
      : latest.sensor_error
        ? null
        : latest.reading;
  updateDaysRemaining(displayReading, usageAnalysis);
  const historyEmptyEl = document.getElementById("history-empty");
  if (historyEmptyEl) historyEmptyEl.style.display = readings.length === 0 ? "block" : "none";
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
  try {
    const saved = JSON.parse(localStorage.getItem("tankRange2"));
    if (saved && saved.type) currentRange = { type: saved.type, offset: saved.offset || 0 };
  } catch (err) {}
  document.querySelectorAll("#range-pills button").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentRange = { type: btn.dataset.range, offset: 0 };
      saveRange();
      updateDashboard();
    });
  });
  const prevBtn = document.getElementById("range-prev");
  const nextBtn = document.getElementById("range-next");
  if (prevBtn) prevBtn.addEventListener("click", () => {
    currentRange.offset = (currentRange.offset || 0) + 1;
    saveRange();
    updateDashboard();
  });
  if (nextBtn) nextBtn.addEventListener("click", () => {
    currentRange.offset = Math.max(0, (currentRange.offset || 0) - 1);
    saveRange();
    updateDashboard();
  });

  // Fetch server config first so charts + level math use authoritative constants.
  await fetchConfig();
  await updateDashboard();
  // Only auto-refresh when viewing the current block, so a background refresh
  // doesn't yank you out of a historical view mid-browse.
  setInterval(() => { if ((currentRange.offset || 0) === 0) updateDashboard(); }, REFRESH_INTERVAL_MS);
}

init();

// -----------------------------------------------------------------------------
// Tabs (Dashboard / Calendar) + the Calendar view itself
// -----------------------------------------------------------------------------

const calendarState = {
  year: null,
  month: null, // 0-indexed
  bookings: null, // null = not yet loaded; [] = loaded but empty
};

// Categorize a booking by its summary text. Matches Michael's VRBO conventions:
// "Reserved - <name>" = paying guest; anything mentioning "closed" or "winter" =
// off-market (no one there); everything else (incl. bare "Blocked") = family.
function categorizeBooking(b) {
  const s = (b.summary || "").toLowerCase();
  if (s.includes("closed") || s.includes("winter")) {
    return { kind: "closed", label: b.summary || "Closed" };
  }
  if (s.startsWith("reserved")) {
    const name = (b.summary || "").replace(/^reserved\s*-\s*/i, "").trim() || "Guest";
    return { kind: "guest", label: name };
  }
  return { kind: "owner", label: "Blocked" };
}

async function fetchAllBookings() {
  try {
    const r = await fetch("/api/bookings");
    if (!r.ok) return [];
    return (await r.json()).bookings || [];
  } catch (err) {
    return [];
  }
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle("active", isActive);
        b.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      document.querySelectorAll(".tab-content").forEach((c) => {
        c.classList.toggle("active", c.id === `tab-${target}`);
      });
      if (target === "calendar") loadCalendar();
    });
  });
}

async function loadCalendar() {
  if (calendarState.year === null) {
    const now = new Date();
    calendarState.year = now.getFullYear();
    calendarState.month = now.getMonth();
  }
  if (calendarState.bookings === null) {
    calendarState.bookings = await fetchAllBookings();
  }
  renderCalendar();
}

function navigateMonth(delta) {
  let { year, month } = calendarState;
  month += delta;
  if (month < 0) {
    month = 11;
    year -= 1;
  } else if (month > 11) {
    month = 0;
    year += 1;
  }
  calendarState.year = year;
  calendarState.month = month;
  renderCalendar();
}

function goToToday() {
  const now = new Date();
  calendarState.year = now.getFullYear();
  calendarState.month = now.getMonth();
  renderCalendar();
}

function renderCalendar() {
  const { year, month, bookings } = calendarState;
  const grid = document.getElementById("calendar-grid");
  const label = document.getElementById("cal-month-label");
  if (!grid || !label) return;

  grid.innerHTML = "";
  label.textContent = new Date(year, month, 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });

  // Day-of-week header row.
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
    const cell = document.createElement("div");
    cell.className = "cal-dow";
    cell.textContent = d;
    grid.appendChild(cell);
  });

  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay(); // 0=Sun..6=Sat
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;

  const today = new Date();
  const isToday = (d) =>
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();

  // For each cell, compute the date it represents.
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startDow + 1;
    const cellDate = new Date(year, month, dayNum); // JS handles month overflow
    const isOtherMonth = cellDate.getMonth() !== month;

    const cell = document.createElement("div");
    cell.className = "cal-day";
    if (isOtherMonth) cell.classList.add("other-month");
    if (isToday(cellDate)) cell.classList.add("today");

    const dayNumEl = document.createElement("div");
    dayNumEl.className = "cal-day-num";
    dayNumEl.textContent = cellDate.getDate();
    cell.appendChild(dayNumEl);

    // Bookings active on this date: end_ts > cellStart AND start_ts < cellEnd.
    // iCal DTEND is exclusive, so a booking ending on day X doesn't cover day X.
    const cellStart = cellDate.getTime();
    const cellEnd = cellStart + 86_400_000;
    const active = (bookings || []).filter((b) => {
      const bStart = new Date(b.start_ts).getTime();
      const bEnd = new Date(b.end_ts).getTime();
      return bStart < cellEnd && bEnd > cellStart;
    });

    if (active.length > 0) {
      const pills = document.createElement("div");
      pills.className = "cal-pills";
      active.forEach((b) => {
        const cat = categorizeBooking(b);
        const pill = document.createElement("div");
        pill.className = `cal-pill cal-pill-${cat.kind}`;
        pill.textContent = cat.label;
        // Tooltip with full date range and original summary.
        const s = new Date(b.start_ts).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
        const e = new Date(b.end_ts).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
        pill.title = `${b.summary || cat.label}\n${s} → ${e}`;
        pills.appendChild(pill);
      });
      cell.appendChild(pills);
    }

    grid.appendChild(cell);
  }
}

// Wire up calendar navigation.
document.getElementById("cal-prev")?.addEventListener("click", () => navigateMonth(-1));
document.getElementById("cal-next")?.addEventListener("click", () => navigateMonth(1));
document.getElementById("cal-today")?.addEventListener("click", goToToday);

setupTabs();

// -----------------------------------------------------------------------------
// PWA: register the service worker + a lightweight offline banner.
// -----------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW registration failed", e));
}
(function offlineBanner() {
  const el = document.getElementById("net-banner");
  if (!el) return;
  const sync = () => {
    if (navigator.onLine) {
      el.hidden = true;
    } else {
      el.textContent = "Offline — showing last-known data";
      el.hidden = false;
    }
  };
  window.addEventListener("online", sync);
  window.addEventListener("offline", sync);
  sync();
})();

// -----------------------------------------------------------------------------
// Web push: enable/disable alerts on this device, with iOS install gating.
// Mirrors the Crumb PWA's push UX. iOS only delivers push to a PWA that's been
// added to the Home Screen (iOS 16.4+), and permission must be tapped from
// inside the installed app — hence the install hint below.
// -----------------------------------------------------------------------------
(function initPush() {
  const el = document.getElementById("push-control");
  if (!el) return;

  const pushSupported = () =>
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isStandalone = () =>
    (window.matchMedia && matchMedia("(display-mode: standalone)").matches) ||
    navigator.standalone === true;
  const isIOS = () =>
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  function urlB64ToUint8Array(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  let serverSubs = 0;
  let pushConfigured = false;

  async function refreshServerState() {
    try {
      const s = await (await fetch("/api/settings")).json();
      pushConfigured = !!s.push_configured;
      serverSubs = s.push_subscriptions || 0;
    } catch (_) {}
  }

  async function subscribeAndStore() {
    const reg = await navigator.serviceWorker.ready;
    const key = (await (await fetch("/api/push/vapid-public-key")).json()).key;
    if (!key) throw new Error("no server key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
    }
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
  }

  async function enable() {
    try {
      if (!pushSupported()) return;
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { render(); return; }
      await subscribeAndStore();
      localStorage.setItem("watertank_push", "1");
      await refreshServerState();
      render();
    } catch (e) {
      console.warn("push enable failed", e);
      render();
    }
  }

  async function disable() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await fetch("/api/push/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        } catch (_) {}
        try { await sub.unsubscribe(); } catch (_) {}
      }
      localStorage.removeItem("watertank_push");
      await refreshServerState();
      render();
    } catch (e) {
      console.warn("push disable failed", e);
    }
  }

  async function test() {
    try { await fetch("/api/push/test", { method: "POST" }); } catch (_) {}
  }

  // Silent re-subscribe when permission is granted but the server lost the sub
  // (e.g. after a DB reset or the browser rotated the subscription).
  async function maybeResubscribe() {
    try {
      if (!pushSupported() || Notification.permission !== "granted") return;
      if (localStorage.getItem("watertank_push") !== "1" || serverSubs !== 0) return;
      await subscribeAndStore();
      await refreshServerState();
      render();
    } catch (_) {}
  }

  function render() {
    let html;
    if (!pushConfigured) {
      html = '<span class="push-hint">Push not configured on the server.</span>';
    } else if (!pushSupported()) {
      html = '<span class="push-hint">This browser can’t show notifications.</span>';
    } else if (isIOS() && !isStandalone()) {
      html = '<span class="push-hint">To get alerts on your iPhone: tap Share → <b>Add to Home Screen</b>, then open Bach Tank from the home screen and enable alerts there.</span>';
    } else if (Notification.permission === "denied") {
      html = '<span class="push-hint">Notifications are blocked. On iPhone: Settings → Notifications → Bach Tank → Allow, then reopen.</span>';
    } else if (Notification.permission === "granted" && localStorage.getItem("watertank_push") === "1") {
      html =
        '<span class="push-on">✓ Alerts on for this device</span> ' +
        '<button type="button" class="push-btn" id="push-test">Test</button> ' +
        '<button type="button" class="push-btn push-btn-ghost" id="push-off">Turn off</button>';
    } else {
      html = '<button type="button" class="push-btn" id="push-enable">Enable alerts on this device</button>';
    }
    el.innerHTML = html;
    const be = document.getElementById("push-enable");
    if (be) be.addEventListener("click", enable);
    const bt = document.getElementById("push-test");
    if (bt) bt.addEventListener("click", test);
    const bo = document.getElementById("push-off");
    if (bo) bo.addEventListener("click", disable);
  }

  (async () => {
    render(); // instant paint from local state
    await refreshServerState();
    render();
    maybeResubscribe();
  })();
})();

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
