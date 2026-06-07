#!/bin/sh
# Run on the Proxmox host. Idempotent: creates /root/water-tank-monitor.git as a
# bare repo if missing, then installs hooks/post-receive into it.
#
# Usage (from your local repo):
#   scp hooks/post-receive root@ssh-proxmox.franks.nz:/tmp/post-receive
#   ssh root@ssh-proxmox.franks.nz 'bash -s' < hooks/install.sh
#
set -e

BARE=/root/water-tank-monitor.git
HOOK_SRC=/tmp/post-receive

if [ ! -d "$BARE" ]; then
  echo "[install] creating bare repo at $BARE"
  git init --bare "$BARE"
else
  echo "[install] bare repo already exists at $BARE"
fi

if [ ! -f "$HOOK_SRC" ]; then
  echo "[install] ERROR: $HOOK_SRC not found. SCP it into place first:"
  echo "  scp hooks/post-receive root@ssh-proxmox.franks.nz:/tmp/post-receive"
  exit 1
fi

cp "$HOOK_SRC" "$BARE/hooks/post-receive"
chmod +x "$BARE/hooks/post-receive"
echo "[install] post-receive hook installed at $BARE/hooks/post-receive"

echo
echo "Now from your local repo:"
echo "  git remote add deploy proxmox-claude:$BARE"
echo "  git push deploy main"
