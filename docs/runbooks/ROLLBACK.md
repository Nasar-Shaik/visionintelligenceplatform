# Rolling back

Two different situations, and confusing them is how a five-minute problem becomes a data-loss
problem.

| Situation                                                             | What to do                                        | Cost                        |
| --------------------------------------------------------------------- | ------------------------------------------------- | --------------------------- |
| The new code is bad; the data is fine                                 | **[Roll back the code](#a-roll-back-the-code)**   | minutes, no data loss       |
| The data is wrong — a bad migration, a destructive action, corruption | **[Restore from backup](#b-restore-from-backup)** | everything since the backup |

Try (A) first. It is reversible; (B) is not.

---

## A. Roll back the code

The deployment is a git checkout plus locally built images, so rolling back is checking out the
previous commit and rebuilding.

```sh
cd /opt/vip
git rev-parse HEAD                        # note the bad one first
git checkout "$(cat backups/last-known-good.sha)"     # or an explicit sha/tag
infra/docker/prod.sh up -d --build
```

Verify:

```sh
infra/docker/prod.sh ps                 # 15 healthy
curl -kfsS https://localhost/ready
```

…then the browser loop from [DEPLOYMENT.md §5](DEPLOYMENT.md). Health checks did not catch the
P-5.8 playback defect; a human playing a clip did.

### When rolling back the code is not enough

**If the bad release changed index definitions**, the old code will reconcile them back on startup.
That is handled, but it is not instant on a large collection.

**If the bad release wrote documents in a new shape**, rolling back the code leaves those documents
in place. Old code reads them with defaults applied, which is usually fine and occasionally is not.
If the release notes mention a data shape change, prefer (B).

**If the bad release ran a destructive action**, the code rollback does nothing at all. Go to (B).

---

## B. Restore from backup

Undoes everything since the backup — every incident raised, every note written, every recording
ingested. That is the trade, and it should be a deliberate decision, not a reflex.

```sh
cd /opt/vip
git checkout "$(cat backups/last-known-good.sha)"
infra/docker/prod.sh up -d --build
infra/docker/restore.sh backups/<timestamp>
```

Order matters: get the **code** back to a version that matches the backup's data shape first, then
restore the data into it. Restoring old data under new code is the combination most likely to leave
you debugging two problems at once.

Full procedure and verification: [BACKUP.md](BACKUP.md).

---

## Deciding under pressure

1. **Is anyone losing work right now?** If operators cannot investigate, roll back first and
   diagnose from the logs afterwards. Logs survive; a stalled investigation does not.
2. **What actually broke?** `infra/docker/prod.sh logs --since 15m | grep '"level":50'`. Every error
   response carries a `correlationId` that matches `reqId` in the logs across services, so a
   user-reported failure maps to exact lines.
3. **Did the data change?** If not, (A) is enough. If you are unsure, take a backup of the _current_
   broken state before doing anything — it costs seconds and preserves the evidence:
   ```sh
   infra/docker/backup.sh backups/broken-$(date -u +%Y%m%dT%H%M%SZ)
   ```

---

## Rolling back one service

```sh
git checkout <good-sha> -- services/gateway
infra/docker/prod.sh up -d --build gateway
```

Only when the change is genuinely confined to that service. If a shared package changed, every image
contains it, and a partial rollback leaves services disagreeing about a contract — a subtler failure
than the one being fixed. Roll the whole checkout back instead.
