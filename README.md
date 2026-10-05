# Suit Derby

A multiplayer horse race driven by a deck of cards. Four horses, one per suit. Every card drawn
moves its suit one space, rank never matters, first to the finish wins.

Play credits only. No real money of any kind.

This version is fully static, so GitHub Pages can host it for free. There is no game server:
the host's browser runs the game, and other players connect directly to it.

## Put it on GitHub Pages

1. On github.com, click **New repository**. Name it `suit-derby`, set it to **Public**, and create it.
2. On the empty repo page, click **uploading an existing file**. Drag in everything in this folder:
   `index.html`, `app.js`, `engine.js`, `net.js`, `sound.js`, `style.css`, `README.md`, and the
   `vendor` and `tests` folders. Click **Commit changes**.
3. Go to the repo's **Settings**, then **Pages**. Under "Build and deployment", set Source to
   **Deploy from a branch**, pick **main** and **/ (root)**, and click **Save**.
4. After a minute or two the page shows your link: `https://YOUR-USERNAME.github.io/suit-derby/`

To change a setting later, edit `engine.js` on GitHub (pencil icon) and commit. The site updates
in about a minute.

## Playing

- One person clicks **Create a room** and shares the room code or the invite link.
- Everyone else opens the link, enters a name, and joins.
- The host's tab runs the game, so the host should keep it open and in front, ideally on a
  computer. If the host reloads, the room comes back and players reconnect on their own. If the
  host closes the tab for good, the room ends and any bets still riding are refunded.

## How it works

| File | What it does |
| --- | --- |
| `engine.js` | All game rules and every setting: deck, secure shuffle, card burning, exact odds, bet validation, race, payouts, balances |
| `net.js` | Browser-to-browser connections using PeerJS (WebRTC) |
| `app.js` | Screens, track animation, betting form, results |
| `vendor/peerjs.min.js` | PeerJS 1.5.5 (MIT license), included so the game has no build step |

**Who decides what.** The host's browser generates and shuffles the deck, burns cards, computes
odds, validates every wager, draws cards, picks the winner and pays out. Other players only send
intents ("bet 10 on Clubs") and receive results. They never receive the deck or burned cards.
The host's own browser holds the game, so a determined host with developer tools could tamper
with it. That is the tradeoff for needing no server. For a game among friends with play credits,
it's fine.

**Odds.** After the burn, the engine computes each horse's exact chance of finishing first from the
cards that remain. Multiplier = 1 / chance, rounded down to one decimal (a 25% horse pays 4.0×).

**Balances.** Credits are saved in the host's browser, keyed to a private ID in each player's
browser. Play with the same host on the same device and your balance carries over. Join a
different host and you start at 100 in their room.

**Connections.** A free public PeerJS service introduces browsers to each other. After that, game
traffic goes directly between players. Some strict networks (many workplaces, schools and
government networks) block these direct connections. If someone can't join, try a home network or
phone data.

## Testing

`tests/engine.test.js` plays full races against the rules, tries invalid and duplicate bets, and
simulates a host reload. Run it with Node.js: `node tests/engine.test.js`. It isn't needed to play.
