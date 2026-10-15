# infra/headscale

PD does not run its own Headscale. The server joins the existing admin network (the Headscale on
`shaavir-prod-01`, `[admin_network] login_server` in `config/tenant.toml`) with the tag `tag:pd`.

| File | Runs on | What it does |
|---|---|---|
| `server-join.sh` | the PD server, root | Tailscale from the official apt repository, then `tailscale up --login-server=... --advertise-tags=tag:pd` with the pre-auth key from `$PD_TS_AUTHKEY` or a hidden prompt (never in argv) |

Mirrors Drive's `infra/headscale/server-join.sh` (Drive PR #3 layout).

## Owner action (HUMAN-TODO H-06)

The Headscale policy lives in the **Drive** repository and on `shaavir-prod-01`; this repository does not edit
either. Before the server can be reached over the admin network, add to that policy:

- `tag:pd` to `tagOwners` (same owners as the Drive server tag), and
- an ACL that lets `group:admins` reach `tag:pd:22`.

Create a pre-auth key for `tag:pd` on the Headscale host (Drive's `infra/headscale/create-preauth-key.sh --server`),
then run `sudo infra/headscale/server-join.sh` on the PD server and paste the key at the hidden prompt.
Until the policy allows `tag:pd`, SSH works only inside the bootstrap window (`[infra] bootstrap_ssh_hours`)
or through the provider console (open question Q-07).
