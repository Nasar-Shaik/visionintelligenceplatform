# Backup and disaster recovery

**A deployment is not production-ready until recovery is proven.** The procedure below was executed
end to end during P-5.8: the running deployment was destroyed with its volumes, rebuilt from nothing,
and restored. The verification numbers at the bottom are from that run, not from intent.

---

## 1. What has to be backed up

Three independent states. Restoring any two of them leaves an unusable system.

| Artefact           | Holds                                                                                         | Regenerable?                             |
| ------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `mongo.archive.gz` | incidents, evidence manifests, custody log, rules and versions, users, cameras, audit history | no                                       |
| `objects.tar.gz`   | the recordings and evidence bytes                                                             | no                                       |
| `config.env`       | `.env.production`                                                                             | **no — and it is the one people forget** |

> ⚠️ `config.env` contains `CREDENTIAL_ENCRYPTION_KEY`, which derives the key that encrypts camera
> credentials at rest. Restore the database without it and the rows come back intact and permanently
> undecryptable. It also holds `JWT_SECRET`, `INTERNAL_API_KEY` and every datastore password — so the
> backup directory needs the same protection as the deployment. `backup.sh` writes it `0600` and says
> so.

---

## 2. Taking a backup

```sh
infra/docker/backup.sh                      # → ./backups/<UTC timestamp>/
infra/docker/backup.sh /mnt/backups/vip     # or an explicit destination
```

Produces the three artefacts plus a `MANIFEST` recording when it was taken, from which host, and the
byte counts — so a restore can tell what it is looking at.

The database is dumped with `mongodump --archive --gzip` through the running container. Object
storage is mirrored **object by object** with `mc`, not by copying MinIO's data directory: a raw
volume copy captures MinIO's on-disk format and only restores into an identical MinIO version,
whereas an object mirror restores into any S3-compatible target.

Nightly:

```
15 2 * * *  cd /opt/vip && ./infra/docker/backup.sh /mnt/backups/vip >> /var/log/vip-backup.log 2>&1
```

### What this does not give you

`mongodump` against a single node is consistent **per collection**, not point-in-time across
collections. A backup taken while an incident is being raised can contain the incident without its
notification. For a deployment that cannot tolerate that, run MongoDB as a replica set and add
`--oplog`. Recorded as **TD-38** rather than left implied.

---

## 3. Restoring

### Into the existing deployment

```sh
infra/docker/restore.sh backups/20260804T030330Z
```

It prints the manifest, names the target, and requires you to type `restore`. A restore aimed at
production because the operator forgot to switch env files is not a recoverable mistake.

`mongorestore --drop` is used, so the result is the state of the backup, not the backup merged into
whatever was there. Services are restarted afterwards — they hold connections and cached index state,
and a `--drop` restore removes the collections beneath them.

### Into a clean host — the case that matters

Order matters. Config **first**.

```sh
# 1. get the code
git clone <repo> vip && cd vip

# 2. restore the configuration BEFORE anything starts
cp /mnt/backups/vip/20260804T030330Z/config.env .env.production

# 3. bring the stack up empty
infra/docker/prod.sh up -d --build

# 4. restore data into it
infra/docker/restore.sh /mnt/backups/vip/20260804T030330Z

# 5. verify (see below)
```

Doing step 2 after step 3 means the stack generates or demands fresh secrets, and the restored camera
credentials will not decrypt.

---

## 4. Verifying a restore

Never declare success on "the command exited 0". Check what an operator would check:

```sh
curl -kfsS https://localhost/ready
```

Then, in a browser: sign in, open the incident, open the investigation, **play a clip**. Playing is
the one action that exercises all three artefacts at once — the manifest from Mongo, the bytes from
object storage, and the signing key from config.

Measured on the P-5.8 restore, after `down -v` destroyed every volume:

| Check                                  | Result                 |
| -------------------------------------- | ---------------------- |
| Login (users + password hashes)        | OK                     |
| Incidents restored                     | 1 / 1                  |
| Evidence records restored              | 3 / 3                  |
| Recording bytes fetched via signed URL | `HTTP 206`, 4096 bytes |
| Chain of custody preserved             | 7 entries              |
| Full browser demonstration             | passed, 10 clicks      |

---

## 5. Recovery objectives

Measured on the P-5.8 dataset (a small one — restore time scales with recording volume, which
dominates):

|                           | Measured                                                   |
| ------------------------- | ---------------------------------------------------------- |
| Backup duration           | ~20 s                                                      |
| Backup size               | 11 MB (11 MB of it recordings)                             |
| Restore into a clean host | ~4 min, including `up -d --build` from a cold cache        |
| Data loss window          | since the last backup — there is no continuous replication |

**RPO is your backup interval.** Nightly backups mean up to 24 hours of incidents and recordings can
be lost. If that is unacceptable, shorten the interval or add replication; the platform does neither
on its own, and this document will not pretend otherwise.

---

## 6. Testing the backup

An untested backup is a hypothesis.

```sh
# on a scratch host, or with VIP_ENV_FILE pointed at a throwaway deployment
cp <backup>/config.env .env.production
infra/docker/prod.sh up -d --build
infra/docker/restore.sh <backup>
```

Then run the browser verification above. Do this on a schedule. The P-5.8 restore was proven by
destroying the deployment first — a restore tested against a system that still has its data proves
only that the command runs.
