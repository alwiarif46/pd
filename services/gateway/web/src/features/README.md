One container per screen: loads data, holds state, calls the API, renders the matching src/ui component. See /CLAUDE.md.
`features/*/ui/` holds hand-built presentational components (shadcn/ui + Tailwind, props and callbacks, rendered outside `.app-shell`); v0 never writes there. Invite codes print as `<orgId>.<token>`: open `#/invite?token=<code>` or paste the code on `#/invite`.
