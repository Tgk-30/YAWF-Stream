# YAWF Stream Docker Compose host updater

This optional host helper installs stable Server Mode updates for one explicitly
registered Docker Compose `debridstreamer` service. It is disabled after
installation. It never runs in the application container and never mounts the
Docker socket into YAWF Stream.

Requirements:

- Ubuntu 22.04 or 24.04 with Docker Engine, Docker Compose, and `flock` from util-linux
- Node.js 24 or newer at `/usr/bin/node`
- the published `ghcr.io/tgk-30/yawf-stream` image
- one named volume mounted read-write at `/data`
- a canonical absolute Compose file and `.env` in a root-owned directory; none
  may be symlinks or writable by group/other
- a deployment path such as `/opt/yawf-stream` or `/srv/yawf-stream` whose
  complete ancestor chain through `/` is root-owned, not group/other writable,
  and free of symlinks; `/tmp` and user-home deployments are intentionally
  rejected

Install and opt in:

```sh
tar -xzf yawf-server-updater_X.Y.Z.tar.gz
cd yawf-server-updater_X.Y.Z
sudo ./install.sh
sudo yawf-server-update register /absolute/path/docker-compose.ghcr.yml
sudo yawf-server-update check
sudo yawf-server-update enable
```

The timer checks hourly but installs only from 03:00 through 05:00 UTC. It
defers while an unexpired stream session is active. `disable` stops the timer;
`status` prints the redacted host status. Running `enable` again clears a
failed-version inhibition and explicitly retries on a future timer run.
The helper checks activity again after the candidate download and immediately
before stopping the service. There is a small unavoidable interval between the
read-only SQLite check and the Compose stop; operators should keep the
maintenance window out of expected playback hours.

Only releases with a strict, digest-pinned `server-update.json` are eligible.
The helper uses the immutable GHCR index digest, never `latest`. It stops and
recreates only the registered application service with `--no-deps`. A narrow
host helper container has only `DAC_OVERRIDE` and `CHOWN`, no network, and only
the exact named volume, private backup, and fixed copy helper mounted. Before
the switch it takes a private symlink-free, ownership-preserving copy and an
opaque copy of `.env`. Failed or interrupted candidates restore the previous
immutable image, volume, and environment file.

The optional read-only bind
`/var/lib/yawf-server-updater/public:/run/yawf-server-updater:ro` exposes only a
redacted status JSON to the application. Policy, journals, backups, Docker, and
the Docker socket remain host-only.
