# Deploy water-tank-monitor server + web to Proxmox LXC 104 via SCP.
# Uses your method: SCP to /tmp/ on ssh-proxmox.franks.nz, then pct push into container 104.
# Run from PowerShell (any directory; script uses full paths to repo).

$ErrorActionPreference = "Stop"
$Repo = "C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor"
$Target = "root@ssh-proxmox.franks.nz"
$ContainerId = 104

Write-Host "Deploying to $Target (container $ContainerId)..." -ForegroundColor Green

# Web files to /tmp/
scp "$Repo\web\app.js" "${Target}:/tmp/"
scp "$Repo\web\index.html" "${Target}:/tmp/"
scp "$Repo\web\style.css" "${Target}:/tmp/"

# Server app (for fw_version etc.) — as app.py in /tmp/, push to server path
scp "$Repo\server\app.py" "${Target}:/tmp/app.py"

# Push into container and restart
ssh $Target "pct push $ContainerId /tmp/app.js /root/water-tank-monitor/web/app.js; pct push $ContainerId /tmp/index.html /root/water-tank-monitor/web/index.html; pct push $ContainerId /tmp/style.css /root/water-tank-monitor/web/style.css; pct push $ContainerId /tmp/app.py /root/water-tank-monitor/server/app.py; pct exec $ContainerId -- systemctl restart water-tank.service; echo Done."

Write-Host "Deploy complete. Check https://bach.franks.nz" -ForegroundColor Green
