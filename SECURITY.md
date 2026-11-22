# Security

## What Ratchet runs

Ratchet runs commands on your machine: the checks, tests and drivers in a project's config, and, for review, the `claude` command. A project config kept in a repository's `.ratchet/` folder is executed when the harness is on for that project, so treat `.ratchet/config.json` in a repository you did not write like any other script in it: read it before switching Ratchet on there.

Ratchet uses no API key and removes API key variables from the environment of the model sessions it starts. It installs no git hook and sends nothing to any service of its own.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting: the **Security** tab of this repository, then **Report a vulnerability**. Include what an attacker could do, the steps, and the commit you tested.

## Supported versions

Only the latest commit on `main` is supported.
