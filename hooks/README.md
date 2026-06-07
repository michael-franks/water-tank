# Deploy hooks

This directory holds the canonical copy of the `post-receive` hook that runs on
the **Proxmox host** when you `git push deploy main`.

## What's here

| File | What it is |
|------|------------|
| `post-receive` | The hook itself. Parse-checks `server/app.py`, snapshots the live tree, promotes `server/` + `web/` into LXC 104 (preserving `server/data/` and `server/.env`), restarts `water-tank.service` only if `server/` files changed, health-checks `/health`, and auto-rolls back on failure. |
| `install.sh` | One-time setup script. Initialises the bare repo and installs this hook into it. |

## Re-installing on a fresh Proxmox host

If `/root/water-tank-monitor.git` is lost (host wipe, accidental delete), run
`hooks/install.sh` from a checkout of this repo. It expects to be run **on the
Proxmox host** (or invoked via SSH from elsewhere):

```bash
# From your local repo, after pushing to GitHub:
scp hooks/post-receive root@ssh-proxmox.franks.nz:/tmp/post-receive
ssh root@ssh-proxmox.franks.nz 'bash -s' < hooks/install.sh
# Then add the deploy remote locally:
git remote add deploy proxmox-claude:/root/water-tank-monitor.git
```

## Editing the hook

Edit `hooks/post-receive` here, commit, push, then re-copy onto the Proxmox
host. The hook is **not** auto-deployed by the deploy itself (it would have to
re-install itself, which is messy).

```bash
scp hooks/post-receive root@ssh-proxmox.franks.nz:/root/water-tank-monitor.git/hooks/post-receive
ssh root@ssh-proxmox.franks.nz 'chmod +x /root/water-tank-monitor.git/hooks/post-receive'
```
