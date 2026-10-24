# Security

aludra gives whoever reaches it an agent that runs commands as you, on a machine with your code, keys and logins. The protections below are about who can reach it, and about the agent's mistakes. They aren't a sandbox against a determined agent.

## Who gets in

- **Loopback only.** The host listens on `127.0.0.1`. Nothing on the network reaches it directly. `tailscale serve` is the way in.
- **Tailscale identity.** `tailscale serve` adds a `Tailscale-User-Login` header to each request from a person's device. aludra lets in only the logins in `api.users`; anything else, including tagged devices and requests with no header, gets 403. There are no passwords or tokens. Without `api.users`, the API and amyrlin's endpoint don't start.
- **Everyone listed is equal.** Every listed login sees and runs every session on the machine, and can change the settings clients can change, approval hosts included. There are no per-user permissions.
- **Some settings are file-only.** Clients can't change `api.users`, `api.port`, `claude.path` or `dataDir`. The first two decide who gets in, the third is the program the host runs, and the fourth is where its data is. Only someone who can edit the settings file changes them.
- **The CLI socket** is `aludra.sock` in the data directory, readable and writable by you only. Anyone who can use it is already you.

Anything else on the machine that can open connections to `127.0.0.1:8724` and set a header could pretend to be a listed login. That includes other local users and any process running as you. On a shared machine, keep that in mind.

## The HTTP API

aludra serves no web app, but a page from another site, open in your browser on a tailnet device, would carry your Tailscale identity if it could send requests to aludra. So:

- POSTs must have a JSON content type (which forces a CORS preflight that aludra never answers) and an `Origin`, if any, matching the host.
- The `/api/live` WebSocket upgrade must come from the same origin, or carry none.
- Every response's Content-Security-Policy is `default-src 'none'`, so a browser runs nothing from one, and none can be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`). No referrer is sent.

## amyrlin's endpoint

`/amyrlin` takes the same identity check, and also refuses any upgrade that carries an `Origin` header. A native app sends none and a browser always does, so a web page can't open it with your identity.

## Model credentials

**Claude.** aludra never signs anyone in to Claude, and never reads or stores Claude credentials. It runs the Claude Code binary you installed (`claude.path`), which uses the login you made with `claude auth login`. The bridge's own settings live in `bridge/` in aludra's data directory, so pi's own bridge settings, if you also use pi, are left alone.

**OpenAI.** `aludra login openai` uses Sign in with ChatGPT, OpenAI's flow for open-source apps running on your own machine. The sign-in registers aludra with your ChatGPT account and grants it use of your plan for model requests; it doesn't grant access to your ChatGPT conversations. The tokens are kept in `credentials.json` in the data directory, owner-only, and the protected-path gate keeps sessions from reading it. Requests go straight to `api.openai.com` with `store: false`, carrying the session's transcript like any model request. Without a sign-in, an `OPENAI_API_KEY` in the host's environment is used instead, billed per token; doctor and the host's log say so.

**OpenRouter.** `aludra login openrouter` uses OpenRouter's OAuth flow, which creates an API key for aludra on your OpenRouter account. It's kept in `credentials.json` like the ChatGPT sign-in, and works until you delete it on OpenRouter's site. Requests go to `openrouter.ai`, which passes them to the model's maker, carrying the session's transcript. An `OPENROUTER_API_KEY` in the host's environment works too.

## Permissions

Inside a session the agent works without asking: reading and editing files, builds, tests, installs, commits. Two things stop it.

### Approvals

These wait for you before they run:

- `git push`, in any form git parses as a push (`git -C dir push`, `/usr/bin/git push`, after `&&` or in a subshell);
- `ssh`, `scp`, `rsync`, `sftp`, `mosh` or `sshfs` naming a host in `approvals.hosts`, as `host`, `user@host`, `host:path` or `host.domain`.

The request is stored, so a restart waits on the same one rather than asking again. It expires after `approvals.waitHours`. [using.md](using.md#approvals) covers answering them.

Approving one "always" (from amyrlin) lets that session run the same kind of call, `git push` or `ssh to host`, without asking again. The rule covers only that session, other sessions still ask, and amyrlin can take it back. Rules are kept with the approvals, so they survive a restart.

### The protected-path gate

Credentials, keys and agent logins are off limits. `read`, `write` and `edit` of these are blocked, and so is a shell command naming one:

- `auth.json` (agent logins) and `cloak.json`;
- `.env`, `.envrc`, `.env.*`;
- `.netrc`, `.npmrc`, `.pypirc`, `kubeconfig`, `credentials` and `credentials.{json,toml,yaml,yml}`, `.credentials.*`, `application_default_credentials.json`, `secrets.{json,toml,yaml,yml}`;
- anything under `.ssh`, `.gnupg`, `private-keys`, `private_keys` or `.pki/private`;
- `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, and files ending `.key`, `.p12`, `.pfx` or `.pem`.

Paths are checked as written and through symlinks. Web URLs in a command are ignored, so downloading a public `.key` file isn't blocked. The first block in a run tells the agent not to try another way and lets it carry on; a second block in the same run ends the run.

The rules are in `src/protected-paths.ts`.

### What they can't do

Both read shell commands as text. A command can always be spelled so neither sees it: a script that pushes, a variable holding a host name, a program that reads a key file itself. They stop the agent from doing these things by mistake or on a whim. They don't contain it.

Sessions run as you, with the PATH the service was installed with, so they can do anything you can from a shell.

## Data at rest

- The data directory is created `0700`, and the service runs with a `0077` umask, so files the host writes are yours alone. Sessions inherit that umask, so files they create in projects are owner-only too.
- The settings file `aludra init` writes is `0600`.
- Backups are `0600` whatever directory they're in, since `backup.dir` may be a shared disk.
- The push key (`push-keys.json`) and the sign-ins (`credentials.json`) are `0600`.

The database holds every session's full transcript, including anything a tool printed. Treat it and its backups like the code they came from.

## Notifications

Notifications go through the browser maker's push service (Apple's, Google's or Mozilla's). Each is encrypted to the device (RFC 8291), so the push service can't read it, and signed with aludra's own key (VAPID, RFC 8292), so the push service accepts it only from aludra. A notification carries the project, the session's title, its latest line, and for an approval the command.
