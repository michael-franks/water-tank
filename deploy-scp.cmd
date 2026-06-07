@echo off
REM Deploy water-tank-monitor to Proxmox LXC 104 via SCP.
REM Double-click in Explorer, or from PowerShell: .\deploy-scp.cmd

set REPO=C:\Users\michael_wearebasis\Documents\Misc\water-tank-monitor
set TARGET=root@ssh-proxmox.franks.nz
set CID=104

echo Deploying to %TARGET% (container %CID%)...

scp "%REPO%\web\app.js" "%TARGET%:/tmp/"
scp "%REPO%\web\index.html" "%TARGET%:/tmp/"
scp "%REPO%\web\style.css" "%TARGET%:/tmp/"
scp "%REPO%\server\app.py" "%TARGET%:/tmp/app.py"

ssh %TARGET% "pct push %CID% /tmp/app.js /root/water-tank-monitor/web/app.js && pct push %CID% /tmp/index.html /root/water-tank-monitor/web/index.html && pct push %CID% /tmp/style.css /root/water-tank-monitor/web/style.css && pct push %CID% /tmp/app.py /root/water-tank-monitor/server/app.py && pct exec %CID% -- systemctl restart water-tank.service && echo Done."

echo.
echo Deploy complete. Check https://bach.franks.nz
