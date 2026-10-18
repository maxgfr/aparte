# Sync

Aparté syncs a vault end to end: each device encrypts what it writes, and a destination only ever stores ciphertext,
the format marker and the keyslots ([spec/FORMAT.md](../spec/FORMAT.md), sections 8 to 10). A destination is set up
once per device; its settings and credentials are kept encrypted on that device only and are never synced.

The web app offers four destinations on the Sync screen: a GitHub repository, an S3-compatible bucket, a folder on this
computer, and an archive file. The CLI adds any Git remote. All of them hold the same objects in the same layout, so
the web app and the CLI can sync one vault through one store.

## When it runs

While the vault is unlocked: at startup, after local changes are saved, when the device comes back online or the page
becomes visible again, every 60 seconds while it is visible, and on **Sync now**. Triggers are grouped over 2 seconds;
after a failure it waits from 1 second up to 5 minutes, and never sooner than the destination's `Retry-After`.

## GitHub repository

Fields: owner, repository, branch (optional), and a fine-grained personal access token.

1. Create a **private** repository. A public one works, but anyone can then see how many encrypted objects it holds
   and their sizes; the app warns about it.
2. On github.com, open Settings › Developer settings › Fine-grained tokens and create a token with:
   - **Repository access:** only this repository;
   - **Repository permissions:** **Contents: Read and write**. GitHub adds **Metadata: Read** to every fine-grained
     token; nothing else is needed.
3. Enter the owner, the repository and the token. The app checks that the account exists, that the token can see the
   repository and that it can push, then clears the token field.

The app calls `https://api.github.com` only (REST, `X-GitHub-Api-Version: 2022-11-28`, `Authorization: Bearer`): the
repository, the branch ref, the Git trees and blobs, and new trees, blobs, commits and ref updates. GitHub's API answers
browsers with CORS headers, so no setup is needed for it. Objects go under the `aparte/` folder (a README is written
there once); each commit has the message `aparte: objects` and the author `aparte <aparte@users.noreply.github.com>`,
whoever wrote it.

Writes follow GitHub's pace: at most 60 per minute and 450 per hour, many objects per commit. A 403 or 429 answer
pauses writes for the time GitHub asks. The token's expiry date, when GitHub sends it, is shown from 7 days before.

Size: Git keeps every object forever, including those of deleted conversations. The screen warns from 1 GiB, as
GitHub recommends keeping repositories under 1 GB; a bucket suits many photos better.

## S3-compatible bucket

AWS S3, Cloudflare R2, MinIO, Backblaze B2 and Garage work. Fields: endpoint (without the bucket, for example
`https://<account>.r2.cloudflarestorage.com`), region (`auto` by default, which R2 expects; MinIO usually wants
`us-east-1`), bucket, folder in the bucket (optional), access key id and secret access key.

- The endpoint must be `https://`, or `http://` on `localhost` or `127.0.0.1` only.
- Requests are path-style (`<endpoint>/<bucket>/<folder>/<name>`) and signed with SigV4 in the browser: `GET` to list
  (`list-type=2`) and read, `PUT` to write, `DELETE` to remove. They send `x-amz-content-sha256`, `x-amz-date`,
  `authorization` (and `x-amz-security-token` with temporary credentials) and read the `Date` header to correct a
  skewed clock.
- Give the key access to this bucket only: list, get, put and delete on its objects.

The bucket must let the app's origin in. The Sync screen shows the rule with the origin filled in; for the deployed app
it is:

```json
[
  {
    "AllowedOrigins": ["https://maxgfr.github.io"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Date"],
    "MaxAgeSeconds": 3600
  }
]
```

Paste it in the bucket's CORS settings (the AWS and R2 consoles take this JSON; MinIO's `mc cors set` and B2 take the
same rule as S3 `PutBucketCors` XML). A self-hosted copy uses its own origin instead. Without the rule, every request
fails as "no answer (offline, or the bucket's CORS rule)". Before saving, the app lists the bucket's `fmt/` prefix to
check access.

## Folder on this computer

A folder you pick with the browser's File System Access API (`showDirectoryPicker`), so Chromium-based browsers only;
elsewhere the tab says the browser cannot write to a folder. Put it in a synced drive (iCloud Drive, Dropbox,
Syncthing) to reach your other computers: names starting with `.`, `.crswap` files and conflict copies are ignored.
The folder is not remembered after a reload, since nothing readable is kept on the device: choose it again, and allow
access when the browser asks.

## Archive

**Export** saves `vault.aparte.zip`: every encrypted object and the keyslots, as stored entries. **Import** merges an
archive into the vault: objects already present are kept, so an old archive loses nothing. Use it as a backup, or to
carry a vault to a device with no shared destination. An archive holds at most 65 535 objects and 4 GiB (no ZIP64).

## Joining a vault from another device

On the web, **I already have a vault** joins from a GitHub repository or an archive; then unlock with the passphrase
and the Secret Key of the Emergency Kit. The CLI joins from a folder, Git, GitHub or S3 (see below).

## What a destination can and cannot do

It sees ciphertext, object names, sizes (padded) and times: [FORMAT §13](../spec/FORMAT.md#13-what-leaks). It cannot
read anything, and it cannot change an object without the change being detected. Each device keeps high-water marks per
destination and raises an alarm when the store rolls back, withholds what it listed before (a gap that lasts across two
listings 10 minutes apart), hides what another device saw, forks, or returns a damaged object; nothing on the device is
deleted because of an alarm. A new device trusts the first state it lists. Deleting data leaves its ciphertext on the
store, and in Git history. Removing a destination deletes nothing from it.

## CLI

```sh
aparte sync setup github owner/repo              # token from APARTE_GITHUB_TOKEN, or asked (Contents read and write)
aparte sync setup git git@host:me/vault.git      # any remote git reaches, with your SSH agent or credential helper
aparte sync setup s3 --endpoint https://<account>.r2.cloudflarestorage.com --bucket vault [--region auto] [--prefix p]
aparte sync setup folder ~/Dropbox/aparte [--label "Dropbox"]
aparte sync now | status | remove <id> | dismiss <alarm id>
aparte vault join github owner/repo              # or folder, git, s3, with the same arguments
```

S3 keys come from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, or are asked. A Git destination uses the system
`git` with prompts off (`GIT_TERMINAL_PROMPT=0`) and writes the layout of the GitHub store, so the web app (through the
API) and the CLI (through `git`) can share one repository. The CLI needs no CORS rule. See [docs/cli.md](cli.md).
