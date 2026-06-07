# Deploy to NUC (Proxmox LXC 104) via SCP

Your usual method: SCP files to `/tmp/` on **ssh-proxmox.franks.nz**, then `pct push` into container 104.

## One-shot

From the `water-tank-monitor` folder (use `.\` in PowerShell):

```powershell
cd C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor
.\deploy-scp.cmd
```

*(Or double-click `deploy-scp.cmd` in Explorer.)*

The script uses the fixed paths and `root@ssh-proxmox.franks.nz` and deploys server + web, then restarts the service.

## Manual (copy-paste)

**1. SCP to Proxmox `/tmp/`**

```powershell
scp C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor\web\app.js root@ssh-proxmox.franks.nz:/tmp/
scp C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor\web\index.html root@ssh-proxmox.franks.nz:/tmp/
scp C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor\web\style.css root@ssh-proxmox.franks.nz:/tmp/
scp C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor\server\app.py root@ssh-proxmox.franks.nz:/tmp/app.py
```

**2. SSH in and push into container 104**

```bash
ssh root@ssh-proxmox.franks.nz
```

Then on the Proxmox host:

```bash
pct push 104 /tmp/app.js /root/water-tank-monitor/web/app.js
pct push 104 /tmp/index.html /root/water-tank-monitor/web/index.html
pct push 104 /tmp/style.css /root/water-tank-monitor/web/style.css
pct push 104 /tmp/app.py /root/water-tank-monitor/server/app.py
pct exec 104 -- systemctl restart water-tank.service
```

*(The extra line deploys the server `app.py` so the API accepts and stores `fw_version`; the web files show it in the footer.)*

## After deploy

- **bach.franks.nz** will serve the new app and web files.
- Footer **Firmware:** will show the version from the last reading; after the next device packet it will show the new version and confirm the FW update.
