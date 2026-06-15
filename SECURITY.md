# Security policy

## Supported versions

The newest published release is the supported version during the pre-1.0 phase. Security fixes may not be backported to older releases.

## Reporting a vulnerability

Do not disclose an exploitable vulnerability, credential leak, sandbox bypass, destructive permission bug, or private-data exposure in a public issue before coordinated review.

Contact the maintainer through the private contact options available on the GitHub profile [@HighIander](https://github.com/HighIander). Include:

- affected version;
- JupyterLab and Codex CLI versions;
- operating system or JupyterHub/container environment;
- exact permission settings;
- minimal reproduction steps;
- expected and observed behavior;
- impact assessment;
- sanitized diagnostics without credentials or private paths where possible.

## Scope

Security-relevant areas include:

- notebook edit-scope bypass;
- unintended direct notebook mutation;
- Agent mode permission or pattern bypass;
- command execution outside documented settings;
- unsafe handling of terminal output or pasted patches;
- credential exposure;
- cross-site scripting in rendered model or terminal output;
- accidental activation of `danger-full-access`;
- misleading claims about sandbox enforcement.

## Important architectural limitation

Agent path categories and whitelist/blacklist patterns are supplied as mandatory model instructions. They are not a separately implemented filesystem ACL. With the Codex OS sandbox disabled, the JupyterHub account and its outer cluster/container isolation are the only hard technical boundary.
