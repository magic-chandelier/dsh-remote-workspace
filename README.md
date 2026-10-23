# DeepSeek Remote Workspace

**Remote workspace plugin for DeepSeek Harness · v0.5.26 · Experimental**

DeepSeek Remote Workspace provides SSH/SFTP and FTP/FTPS file management, plus approved Linux inspection and operations over SSH. Remote tools are scoped to plugin-managed workspaces or verified project bindings; ordinary local conversations cannot select arbitrary servers. It does not transparently replace Harness's native local file and shell tools.

## Features

- Remote file browsing, editing, search, multi-file drag-and-drop upload, chunked transfers, progress and cancellation requests.
- SSH/SFTP and FTP/FTPS connection profiles, trusted session binding and connection approval.
- SSH terminal, CPU/memory/disk/network snapshots, process and systemd inspection and approved operations.
- Credential protection, per-command confirmation, plugin-scoped shutdown and owned-data cleanup.

The Web UI is experimental. Single-file uploads are limited to 128 MiB; recursive folder dropping and transfer resume are not supported. Cancellation cannot undo operations already committed remotely.

## License and risks

**Source available; not OSI open source.** Project-owned materials are offered under the [Personal Research License 1.1](LICENSE) for individual, private, isolated, non-production research and evaluation. Commercial use, any commercial environment, and organizational use (including internal evaluation) are prohibited. Redistribution, public modified versions, repackaging and derivative distribution of protected project code require prior written permission. See the [Chinese license guide](LICENSE.zh-CN.md).

This is experimental remote-management software. File deletion, command execution and service management may cause data loss, downtime or credential exposure. Use only on personal, authorized test systems with separate backups. Warranty and liability exclusions apply only to the extent permitted by law.

Third-party dependencies remain under their own licenses, and valid rights from earlier MIT releases are not retroactively withdrawn. See [third-party notices](THIRD-PARTY-NOTICES.md). **The version remains 0.5.26 across this documentation/license revision; distinguish release snapshots by their source and checksums.**

## Build and documentation

Requires Node.js 20.11+ and a compatible Harness development environment.

```sh
pnpm run verify
pnpm run pack
pnpm run pack:ui-experimental
```

[Comprehensive Wiki (Chinese)](docs/WIKI.zh-CN.md) · [Security policy](SECURITY.md) · [中文版介绍](README.zh-CN.md)

Commit the registry-resolved `pnpm-lock.yaml` before CI runs `pnpm install --frozen-lockfile --ignore-scripts`. Lockfile generation and a frozen install do **not** constitute a completed transitive-dependency license audit: `pnpm run license:installed` must pass on the installed dependency tree, and its report must be reviewed before a release is marked license-reviewed. Real Windows Desktop acceptance is still pending.
