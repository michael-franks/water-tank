# Thinning the readings DB

`thin_readings_to_30min.py` collapses the `readings` table down to one row per
30-minute bucket (the reading closest to the bucket centre wins). Use it to
clean up a noisy historical log — for example after a firmware that sampled
more frequently than the current 30-min cadence.

The script ships with the repo, so it's already on the LXC after any
`git push deploy main`. Run it from your local machine via SSH:

```bash
# 1) Optional: stop the service so nothing writes mid-run.
ssh proxmox-claude "pct exec 104 -- systemctl stop water-tank"

# 2) Back up the DB, then thin.
ssh proxmox-claude "pct exec 104 -- bash -c '
  cd /root/water-tank-monitor/server
  cp data/readings.db data/readings.db.bak
  /root/water-tank-monitor/.venv/bin/python thin_readings_to_30min.py
'"

# 3) Restart.
ssh proxmox-claude "pct exec 104 -- systemctl start water-tank"
```

The script reports how many rows it kept vs deleted and runs `VACUUM` to
reclaim space. Safe to re-run — it's idempotent.

## Recovering if something goes wrong

The `data/readings.db.bak` written in step 2 is the pre-thinning snapshot.
Restore with:

```bash
ssh proxmox-claude "pct exec 104 -- bash -c '
  systemctl stop water-tank
  cp /root/water-tank-monitor/server/data/readings.db.bak /root/water-tank-monitor/server/data/readings.db
  systemctl start water-tank
'"
```
