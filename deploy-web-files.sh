#!/bin/bash
# Deploy web files to LXC container via Proxmox
# Run this from Proxmox host after SSH'ing in

CONTAINER_ID=104
WEB_DIR=/root/water-tank-monitor/web

# Deploy index.html
pct exec $CONTAINER_ID -- python3 << 'ENDPYTHON'
content = '''<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Water Tank Monitor</title>
    <link rel="stylesheet" href="/static/style.css" />
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0"></script>
  </head>
  <body>
    <div class="container">
      <section class="hero">
        <div class="hero-main">
          <div class="hero-left">
            <div class="hero-label">💧 Bach Water Tank Level</div>
            <div class="hero-value" id="hero-level">—</div>
            <div class="hero-badges">
              <span class="badge" id="level-status">—</span>
            </div>
          </div>
          <div class="hero-right">
            <div class="hero-sub" id="hero-liters">—</div>
            <div class="hero-sub" id="hero-days">—</div>
            <div class="hero-sub hero-sensor">
              <span class="badge" id="signal-badge">—</span>
              <span id="hero-sensor">—</span>
            </div>
          </div>
        </div>
      </section>

      <section class="chart-section">
        <h2>History</h2>
        <div class="range-controls">
          <div class="range-custom">
            <input id="custom-range-value" type="number" min="1" value="1" />
            <select id="custom-range-unit">
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
              <option value="months">months</option>
              <option value="years">years</option>
            </select>
            <button id="custom-range-apply" class="range-btn">Apply</button>
          </div>
          <select id="preset-range-select" class="range-select">
            <option value="1d">1 day</option>
            <option value="1w" selected>1 week</option>
            <option value="1m">1 month</option>
            <option value="1y">1 year</option>
            <option value="all">All time</option>
          </select>
          <button class="range-btn" data-range="1d">1 day</button>
          <button class="range-btn" data-range="1w">1 week</button>
          <button class="range-btn" data-range="1m">1 month</button>
          <button class="range-btn" data-range="1y">1 year</button>
          <button class="range-btn" data-range="all">All time</button>
        </div>
        <canvas id="historyChart"></canvas>
      </section>

      <section class="footer-row">
        <div class="last-update footer-update">
          <div class="last-update-header">
            <span class="muted">Last update</span>
          </div>
          <div class="last-update-line" id="last-update">—</div>
          <div class="last-update-line" id="last-update-meta">—</div>
          <div class="last-update-line muted" id="last-update-ago">—</div>
        </div>
        <div class="footer-details">
          <div class="meta" id="level-distance">Sensor reading: —</div>
          <div class="meta" id="signal-details">Signal: —</div>
        </div>
      </section>
    </div>

    <script src="/static/app.js"></script>
  </body>
</html>
'''
with open('/root/water-tank-monitor/web/index.html', 'w') as f:
    f.write(content)
print("✓ index.html updated")
ENDPYTHON

echo "Files deployed! Restarting service..."
pct exec $CONTAINER_ID -- systemctl restart water-tank.service
echo "Done!"
