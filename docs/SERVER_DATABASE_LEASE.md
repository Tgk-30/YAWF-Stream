# Server database ownership and offline migration

The lease-based server holds an exclusive SQLite transaction in
`<database-path>.server.lock` for the lifetime of its application database.
The lease file remains after a clean stop. Its existence is not evidence that
a server is running. Operating-system locks, rather than a recorded PID,
exclude another instance and release ownership when a process dies.

Keep every instance that uses one database on the same local filesystem and
the same database/lease path pair. Separate PID namespaces do not make concurrent
ownership of one shared database safe. Network filesystems,
hard-linked database aliases, and independent lease paths for one database are
not supported. Do not infer their safety from local process tests.

## Normal upgrades and restarts

A healthy older server removes its numeric PID lock during graceful shutdown.
After that verified stop, the lease-based server can initialize its new lease
without changing the application database or master key. A later clean stop
leaves the SQLite lease file in place. Do not remove or rename that file as a
routine restart step, even when its owner is stopped.

The host updater snapshots the stopped volume and opaque environment before
switching images. Keep that complete snapshot for rollback. An image-only
downgrade is insufficient: older PID-based servers intentionally reject a
SQLite lease file, and application schema versions can differ too.

## Legacy numeric lock after an interrupted older server

The new server does not guess whether a recorded PID belongs to a process in
another container. It preserves numeric or unrecognized lock files and refuses
startup with an offline-migration error. This is deliberate protection against
opening a database that another instance may still own.

Only an operator who can stop and account for **all** instances using this exact
database may perform the following transition:

1. Identify the exact database, named volume or bind mount, Compose project and
   service, or native systemd unit. Do not print environment files or secret
   values. Stop only the relevant YAWF services, not unrelated host workloads.
2. Confirm every consumer of that same database is stopped, including other
   containers, native services and desktop-hosted servers. A PID lookup inside
   one container, a single successful health check, or an empty Docker list does
   not by itself establish that no host process uses the data.
3. Make a private, ownership-preserving backup of the entire stopped data
   directory, including the database, any WAL/SHM/journal files, master key,
   existing lock and configuration. Keep the environment separately with the
   same protection. Verify the backup and record hashes without exposing its
   contents. Do not operate on the only copy.
4. Inspect only the exact lease-path file. If it is the old numeric PID format,
   preserve it under a new, non-overwriting archival name while all consumers
   remain stopped. Do not delete it, overwrite an archive, or generalize this
   action to arbitrary files matching `*.lock`.
5. Start one lease-based instance. Verify readiness, the expected version,
   existing login, profiles and library before restoring normal traffic. Keep
   the old container/image and verified backup available until verification
   finishes.

If the lease is already a SQLite file, is malformed, or has `-journal`, `-wal`
or `-shm` sidecars, do **not** use the numeric-file transition. Preserve the
complete set and investigate or restore a verified stopped snapshot. Opening a
foreign database with SQLite can perform recovery or create sidecars even when
the connection is read-only, so this is not a harmless format probe.

## Recovery commands and failed cleanup

Offline restore and owner recovery hold the same exclusive lease throughout
their asynchronous work. A separate online backup remains supported and does
not transfer server ownership. If cleanup cannot close a live connection, the
process retains ownership and fails closed; restart that failed process rather
than removing the lease file to force another owner through.

Test forced termination and rollback only with disposable data and isolated
containers. Do not run crash tests against an active household deployment.

## Rollback

Stop the failed candidate and every other consumer before restoring the
complete pre-upgrade volume and matching environment. The host updater performs
this transaction for its registered service. For a manual rollback, verify the
old image, database/schema, key and lock state as a set before restarting.
If a restored legacy snapshot itself contains an interrupted numeric PID lock,
its stale-state investigation is still required; restoring it does not prove
that it is safe to remove. Never delete an active SQLite lease to make an old
binary start.

SQLite documents both recovery side effects and its database header format:
[WAL and read-only access](https://www.sqlite.org/wal.html#read_only_databases),
[database header](https://www.sqlite.org/fileformat.html#the_database_header).
