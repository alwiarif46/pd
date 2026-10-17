# Chat 4: Render service, fonts, format lock

**Builds:** plan phase 3. **Read:** BUILD-PLAN.md, handoffs/chat-3.md, `design/e2e/INVENTORY.md`, 01 s5, 04 s5.6 and s5.20, 05 s6, 06 s6, 09 s4.10, 08 Phase 3.

## Goal
Word and PDF volumes with computed numbering, a verified page count, and a vision layout check.

## PR list (proposed)
1. Python render service in the uv workspace; toolrunner; bid-autopilot scripts as tools, each with `--selftest` in CI; per-job temp dirs wiped at job end. (fable-reviewer: sandbox and cleanup)
2. Fonts: metric-compatible open fonts only on Linux; per-tenant font mounts. (fable-reviewer: licensing note and tenant isolation)
3. Format lock stage: spec, silent rules, empty shell per volume.
4. Word assembly with python-docx from spec and shell.
5. Code-computed numbering: contents table, caption numbers, cross-reference text written as results.
6. LibreOffice headless DOCX to PDF (one profile dir per slot); librsvg for SVG. LibreOffice may run only in CI; mark local checks "CI-verified".
7. Rasterize pages; vision check for overflow, broken tables, cut-off graphics, orphan headings, margins. Vision calls go through the model gateway and its stub.
8. Page count on the exact PDF to be submitted; Word-only page-limit note.
9. Font request flow: upload, license confirmation, fee record. Screens from `design/e2e/` per BUILD-PLAN s10. (fable-reviewer: fee record)

## Done when (08 Phase 3)
- A test volume renders to Word and PDF; contents table and captions match a hand check.
- Page count matches a hand count of the same PDF.
- The vision check catches each layout fault planted on purpose in a test page.
- Proposed (early form of the 08 Phase 8 check): no render job leaves files behind (test).
