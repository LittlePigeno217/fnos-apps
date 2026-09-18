# fnOS App Test Harness (real-VM)

Installs and smoke-tests app `.fpk` packages on a **real fnOS** virtual machine —
the only place `appcenter-cli` and the actual install/upgrade lifecycle exist.
Codifies the manual bring-up used to validate the fnos-store #189 data-loss fix.

```
test/
├── README.md                # this runbook
├── config.env.example       # copy -> config.env (git-ignored)
├── lib.sh                   # shared helpers (ssh-as-root, apps.json resolve, test_one)
├── rpc.sh                   # daemon-RPC helpers (stage/install/upgrade via the
│                            #   data-preserving socket channel, never install-local)
├── wizard-answers.env       # per-app wizard answers for test-wizard/test-upgrade
├── test-app.sh              # smoke-test ONE app (install/start/volume/uninstall)
├── test-wizard.sh           # test ONE app's wizard submission end-to-end
├── test-upgrade.sh          # test ONE app's upgrade data-preservation
├── run-all.sh               # matrix over apps.json -> report.md
└── test-volume-safety.sh    # #189 cross-volume data-loss regression
```

## ⚠ Destructive — needs a disposable VM
Every test **uninstalls the app at the start and at the end**. Run this harness
only against a throwaway VM you can re-provision or snapshot-revert. Do **not**
point it at a box with apps you care about — it will remove them. The VM this
was built on (`fnOS-test`) was later turned into a real box with ~35 installed
apps (incl. `mihomo`, the only network path) and **no snapshot** — it is no
longer a safe target. Re-provision a fresh VM, or `prlctl snapshot` *before*
any run so you can revert.

## What each app test checks

Each app is installed then uninstalled (disk stays bounded). Stages:

**Hard** (decide pass/fail) — deterministic packaging signals via `appcenter-cli`:
`download` · `install` · `register` (check == Installed) · `volume` (target → `/vol<vol>/@appcenter/...`) · `uninstall`.

**Soft** (informational, never fail the app) — timing/architecture-dependent:
`start` (`SLOW` when status != running within the timeout) · `port` (`DOWN` when `127.0.0.1:<service_port>`
refuses TCP — fnOS apps are normally reached through the gateway, not localhost).

## Wizard & upgrade tests (daemon-RPC, data-preserving)
These go beyond the smoke test. Both drive the app's install/upgrade through the
**daemon socket** (`/var/run/com.trim.app.center.sock`) — the data-preserving
channel the store itself uses — never `install-local`/`install-fpk` (which
uninstalls and destroys data, cf. #189).

```bash
./test-wizard.sh sakurafrp     # submit the app's wizard answers, assert install+running
./test-upgrade.sh sakurafrp    # install → write a data marker → re-version &
                               #   upgrade → assert the marker survived
./test-upgrade.sh gopeed       # native app, no wizard (answers default to [])
```

> **`rpc.sh` is a bash re-implementation of the store's Go daemon client and it
> has already drifted** — it has no equivalent of the transient-poll tolerance
> (`10050` / TRPC timeout) that `fnos-store/internal/platform/rpc.go` gained, and
> `rpc_upgrade` hardcodes `customParameters: []`. To validate the private API
> *as the store actually uses it* — which is what matters after an fnOS upgrade —
> use the probe that calls the shipping Go code instead:
>
> ```bash
> cd ../../fnos-store
> GOOS=linux GOARCH=amd64 go build -o /tmp/rpcprobe ./cmd/rpcprobe
> scp /tmp/rpcprobe fnos-test:/tmp/
> ssh fnos-test 'sudo /tmp/rpcprobe capability'   # then stage/wizard/install/upgrade/uninstall
> ```

`test-upgrade.sh` needs no published version pair: it re-packages the same fpk
with a bumped manifest version (`rpc_bump_fpk`) and offers it as an upgrade, so
every app is testable. The data marker is written into the app's `@appdata` and
must still be there, unchanged, after the upgrade.
Wizard answers come from `wizard-answers.env` (`WIZARD_ANSWERS_<slug>` as a JSON
array of `{"key":..,"value":..}`); apps without an entry submit `[]` (fine for
apps whose wizard fields are all optional). Values are TEST values, never real
secrets.
**fnOS platform facts these tests encode** (measured on 1.2.0203): a wizard field
`type` must be one of `text/password/checkbox/select/radio/switch/tips` — a
`number` field makes the daemon reject the whole package with `10111`; every
`rules` entry needs a `message`; an install runs only `install_init`+
`install_callback` (never `config_callback`); and the daemon rejects `update/task`
with `10500` while the freshly-installed service is still starting — so
`test-upgrade.sh` waits for `status=running` before upgrading.
## Prerequisites (host = macOS)

- A hypervisor (Parallels Desktop used here; QEMU/UTM/VirtualBox also fine).
- `brew install hudochenkov/sshpass/sshpass` · `python3` · `curl`.

## Provisioning the VM (one-time)

fnOS is x86_64; on an **Intel** Mac it runs with native virtualization. The
graphical Debian installer must be clicked through by hand (no keystroke
injection); everything after first boot is scriptable / web-drivable.

1. **Download** the fnOS x86 ISO from <https://fnnas.com/download> (verify md5).
2. **Create the VM** with a system disk + **two data disks** (needed for the
   volume-safety test). With Parallels:
   ```bash
   ISO=~/Downloads/fnos_..._x86_*.iso
   prlctl create fnOS-test --distribution debian --no-hdd
   prlctl set fnOS-test --memsize 8192 --cpus 4
   prlctl set fnOS-test --device-add hdd --size 65536    # system
   prlctl set fnOS-test --device-add hdd --size 20480    # data -> /vol1
   prlctl set fnOS-test --device-add hdd --size 20480    # data -> /vol2
   prlctl set fnOS-test --device-add cdrom --image "$ISO" --connect
   prlctl set fnOS-test --device-del cdrom0              # drop the empty default cdrom
   prlctl set fnOS-test --device-bootorder "cdrom1 hdd0 hdd1 hdd2"
   prlctl set fnOS-test --efi-secure-boot off
   prlctl start fnOS-test
   ```
3. **Graphical install** (in the VM window): pick the **64 GB** disk as the
   system disk, accept partition/swap, format, DHCP, reboot → a terminal shows
   the VM IP. Find it from the host if needed:
   `cat /Library/Preferences/Parallels/parallels_dhcp_leases`.
4. **Web init** at `http://<ip>:5666/` → set device name + super-admin account
   (this account has SSH enabled by default).
5. **Enable SSH**: System Settings → SSH → on.
6. **Create two storage spaces**: System Settings → 存储空间管理 → 创建存储空间,
   one per data disk (ext4 / Basic is fine) → yields `/vol1` and `/vol2`.

## Configure & run

```bash
cd fnos-apps/test
cp config.env.example config.env       # set VM ip/user/pass, volume, arch
./test-app.sh syncthing                # one app
./run-all.sh native                    # all native apps -> report-native.md
./run-all.sh native syncthing gopeed   # just these
./test-volume-safety.sh                # #189 regression (needs /vol1 + /vol2)
```

**Docker apps** (`app_type: docker`) are skipped by the `native` filter. To test
them, first provision the fnOS **Docker app**: open it on the desktop and
initialise its storage onto a volume (e.g. `/vol2`). Without that, appcenter-cli
fails docker installs with `code 12000`. Then `./run-all.sh docker` (or a slug
list) -> `report-docker.md`. The `port` check is a *hard* signal for docker apps
(they bind the host port), unlike gateway-fronted native apps.

## #189 data-loss — validated on fnOS 1.2.0203

`test-volume-safety.sh` reproduces and closes out the bug empirically:

- **A (bug):** an app on `/vol1`, then `install-local -v 2` (a *different* volume)
  → the app is **relocated to `/vol2`** (uninstall-then-reinstall) and its
  `/vol1/@appdata` is **orphaned** — the app now shows empty data. This is why
  users saw "data deleted". `-v` **is honored**, so the store's bug was passing
  the *wrong* (global) volume instead of the app's current one.
- **B (fix):** pinning `install-local -v` to the app's **current** volume — what
  fnos-store ≥1.7.12 computes from `/var/apps/<app>/target` — keeps the app in
  place and **preserves the data**, even when `default-volume` has drifted.

## Limitations

- The graphical Debian install step is manual.
- `-v`/`--volume` and `install-local --dir` are undocumented-but-working
  appcenter-cli flags (see `docs`), relied on here as the store does.
- **Docker apps need the fnOS Docker app provisioned** (open it, initialise its
  storage on a volume). Without it, appcenter-cli fails docker installs with
  `[Error]Something wrong with appcenter: code 12000` (install-fpk nil-panics).
  Once provisioned, docker apps install normally — PoC on this VM: 3/4 small apps
  (it-tools, dpanel, uptime-kuma) pass, homepage fails on a genuine install error.
  A full 91-app docker matrix still needs more disk than 2×20 GB for the image
  pulls; `run-all.sh docker` prunes images between apps to stay bounded.
- Observed during the native run: some apps stayed `running` in `appcenter-cli
  list` after `uninstall` returned success (CLI state can lag — cf. #189). Verify
  `list` / `/var/apps` between runs if a clean slate matters.
