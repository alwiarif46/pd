# Enhancements to Atrium

Every change we make to Atrium's look or behavior gets one line here (BUILD-PLAN s10 item 3): screen, change, why.
`atrium-design/` itself is never edited; these are changes in the integrated code.

| Date | Screen | Change | Why |
|---|---|---|---|
| 17 Oct 2026 | Tokens, all | Atrium's variables copied into `apps/web/src/styles/tokens.css` unchanged. Dark values apply under `.dark` on `<html>` (Atrium scopes them to `.theme-atrium.dark`). | The app sets one class on `<html>` and needs no wrapper element. Same colors. |
| 17 Oct 2026 | Tokens, all | `@theme static inline` instead of `@theme inline`. | `inline` lets `.dark` sit on any ancestor; `static` keeps the variables for `sonner.tsx`, which reads `var(--color-popover)` from JS. The legacy stylesheet's own `--muted` and `--card` were renamed `--legacy-muted` and `--legacy-card`, because Atrium uses those names. |
| 17 Oct 2026 | Type, all | IBM Plex Sans and Mono are bundled with `@fontsource` instead of loaded by `next/font/google`. | No call to Google at runtime (privacy plan 07). Same faces and weights. |
| 17 Oct 2026 | Tokens, PD screens | PD's plan 09 names (`ink`, `canvas`, `paper`, `line`, `weekend`, `today`, `due`) are aliases of Atrium tokens. `holiday`, `warning` and the team colors stay as domain tokens. `font-numeric` is Plex Mono. | The screens already integrated keep working and follow the theme in dark mode. |
| 17 Oct 2026 | Theme | Dark mode starts off and follows a stored choice only (`src/lib/theme.ts`). It does not follow the OS setting yet. | The legacy screens have no dark styles. The OS setting is read once they are retired. |
| 17 Oct 2026 | Tokens, domain colors | `holiday`, `warning` and the team colors have one value in both themes for now. Dark values and a contrast check come with the Schedule and Reviews screens (chat 2 and 6). | Those screens are the only users; picking dark values without seeing them is guesswork. INVENTORY 3.3 lists this as build work. |
| 17 Oct 2026 | Shell, auth, membership headers | Headers styled `bg-ink text-paper` turn light in dark mode, while Atrium's sidebar stays dark. Known drift; fixed when the shell is integrated (chat 2) by using the `sidebar` tokens. Nobody can reach dark mode before then. | `ink` and `paper` follow the theme. |
