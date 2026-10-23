# Third-party software and notices

Project-owned DeepSeek Remote Workspace materials covered by the current root `LICENSE` are distributed under the restrictive Personal Research License 1.1, to the extent the applicable rights holders can grant it. Older releases may have separate valid MIT rights. **Neither project license relicenses third-party dependencies.** No `node_modules` directory is bundled in the release tarballs; npm/the host may supply the following packages as separate installations. Their individual terms remain in force.

| Declared package | Version constraint | Upstream license (unlocked, subject to verification) | Upstream |
| --- | --- | --- | --- |
| `ssh2-sftp-client` | `^11.0.0` | Apache-2.0 | https://github.com/theophilusx/ssh2-sftp-client |
| `basic-ftp` | `^5.3.1` | MIT; directory listing parser material from Apache Commons Net under Apache-2.0 | https://github.com/patrickjuchli/basic-ftp |
| `ssh2` | `^1.16.0` | MIT | https://github.com/mscdex/ssh2 |
| `@deepseek-ai/schemastery` | `*` | MIT (verify installed version) | https://www.npmjs.com/package/@deepseek-ai/schemastery |
| `@deepseek-ai/cordis` (peer) | `*` | MIT (verify installed version) | https://www.npmjs.com/package/@deepseek-ai/cordis |
| `@deepseek-ai/dsh-tools` (peer) | `*` | BSD-3-Clause (verify installed version and rights holder notice) | https://www.npmjs.com/package/@deepseek-ai/dsh-tools |
| `react` (host runtime, not packaged) | host-supplied | MIT | https://github.com/facebook/react |

## License copies and notices already preserved

- Apache License Version 2.0: `third_party/licenses/Apache-2.0.txt` (the standard license terms; verify package-specific copyright headers when distributing dependency source).
- basic-ftp upstream MIT permission and copyright: `third_party/licenses/basic-ftp-MIT.txt`.
- Apache Commons Net attribution **from basic-ftp upstream `NOTICE.txt`**: `third_party/notices/basic-ftp-Apache-Commons-Net-NOTICE.txt`.

The basic-ftp upstream explicitly acknowledges parts of the Apache Commons Net directory listing parsers. These attribution files are included proactively and are **not** substitutes for any NOTICE / LICENSE distributed within individual installed dependency packages.

## IMPORTANT: Not a complete resolved dependency inventory

A registry-resolved `pnpm-lock.yaml` records dependency resolution, but does **not** by itself verify the licenses, provenance, or notices of the full installed tree. Transitive, peer, platform-specific and optional dependencies are not exhaustively inventoried in this document. Before publishing binaries with bundled dependencies or marking a release as license-reviewed, commit the generated lockfile, run `pnpm install --frozen-lockfile --ignore-scripts`, run `pnpm run license:installed`, review the resulting machine-readable dependency report, and preserve actual upstream LICENSE / NOTICE files for code you embed or redistribute. Fail closed on unrecognized SPDX license expressions. See `docs/WIKI.zh-CN.md` for the release and compliance checklist.

The names of third-party licensors are not used to imply sponsorship or endorsement.
