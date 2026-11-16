# ⬡ Tej's Catan

A free, browser-based hex-settlement board game in the spirit of the classic — playable with friends over a link, no accounts, no server.

**Play:** https://tejchak.github.io/tej-catan/

## How multiplayer works
The table creator's browser hosts the game; friends connect peer-to-peer (WebRTC via PeerJS). Share the invite link or 4-letter code. Keep the host tab open while playing — if the host refreshes, the game resumes from their browser's saved state.

## Maps (all free)
- **The Classic Isle** — the original 19-hex board, 2–4 players
- **The Greater Isle** — extended 30-hex board for 5–6 players
- **Isles & Tides** — Seafarers-style: ships, gold fields, island-discovery VPs

## Files
- `index.html` — page, styles, layout
- `core.js` — pure game engine: hex geometry, board generation, rules
- `net.js` — peer-to-peer transport (PeerJS), host-authoritative state sync
- `ui.js` — rendering and player actions
