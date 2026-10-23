# Security policy

This plugin can run commands and modify files on remote servers. Test new releases in an isolated Harness profile, with a nonprivileged SSH account and a disposable server before granting broad privileges.

Do not post secrets, live tokens, SSH private keys or `credentials.json` in public issues. To report a suspected vulnerability, use GitHub's private vulnerability reporting feature if enabled by the repository owner; otherwise contact the maintainer privately before disclosure.

AES-256-GCM credential storage uses Windows DPAPI for the wrapping key on Windows. The obfuscation option is reversible encoding **not encryption**. An SSH agent should not be given unsupervised destructive permissions. `remote_shell` requires approval for each command; `remote_exec` uses an exact allowlist. Host-key verification must not be silently disabled.

The current Web UI is experimental and not validated against every Harness Desktop version. Uninstalling the plugin does not automatically guarantee removal of persisted plugin data; use the in-plugin cleanup workflow first and back up information you intend to keep.
