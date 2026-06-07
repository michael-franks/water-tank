# Commands to thin readings to 30 minutes

Run these from **PowerShell** (your Windows machine). Then run the block on the Proxmox host.

---

## 1. Copy the script to Proxmox

```powershell
scp C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor\server\thin_readings_to_30min.py root@ssh-proxmox.franks.nz:/tmp/
```

---

## 2. SSH to Proxmox

```powershell
ssh root@ssh-proxmox.franks.nz
```

---

## 3. On the Proxmox host (paste this whole block)

```bash
# Push script into container 104
pct push 104 /tmp/thin_readings_to_30min.py /root/water-tank-monitor/server/thin_readings_to_30min.py

# Optional: stop the service so nothing writes during thinning
pct exec 104 -- systemctl stop water-tank.service

# Backup DB, run thin script
pct exec 104 -- bash -c "cd /root/water-tank-monitor/server && cp data/readings.db data/readings.db.bak && python3 thin_readings_to_30min.py"

# Restart the service
pct exec 104 -- systemctl start water-tank.service
```

---

## 4. Exit SSH

```bash
exit
```

Done. The DB now has one reading per 30-minute bucket; old 1-min data is thinned.
