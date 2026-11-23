# Preferans — private online game for three players

Play a complete 3-human multiplayer game in a browser, based on the **[Preferans Klub rules, version 1.2](https://www.preferansklub.com/pravila1.htm)**. The game includes hidden hands, private invite rooms, legal move enforcement, real-time WebSocket synchronization and automatic scoring.

## Start on your computer

1. Install [Node.js 22+](https://nodejs.org/). **No `npm install` or database is needed.**
2. Open a terminal inside this folder and run:

   ```bash
   npm start
   ```

3. Open `http://localhost:3000` in your browser. Create a private room. The host can choose a starting bula (10, 25, 50, or 100) and maximum active refe (0–5).
4. Share the room's invitation URL with **exactly two other people**. Each player uses a separate browser/device. After all three join, the host clicks **Deal the first hand**.

To play over the public internet, deploy the app as described below; `localhost` is for your own computer only.

## Deploy as a real website

### Render (simple option)

1. Upload this entire folder to a new **GitHub repository**. Keep `render.yaml` at the root.
2. In [Render](https://dashboard.render.com/), choose **New → Blueprint**, select that GitHub repository, and approve the web service. Alternatively, choose **New → Web Service**, connect the repository, and set:
   - Runtime: **Node**
   - Build: `npm install` (there are no dependencies)
   - Start: `npm start`
   - Health check: `/health`
3. Render will give you a public HTTPS website such as `https://your-app.onrender.com`. **This is your playable online game URL.** Open it and invite two friends with the in-game link.

This project also works on other single-instance Node hosts (Railway, Fly.io, a VPS). The host must support **WebSocket upgrades**, long-lived connections, and the `PORT` environment variable. HTTPS deployments automatically use secure `wss://` WebSockets. No API keys are needed.

**Hosting limitations:** Rooms live in server memory, not in a database. **A restart, app sleep/redeployment or instance replacement removes active rooms and game progress.** Free hosts can sleep when idle. Use one server instance; horizontal scaling is not supported. If you want durable, production-grade games later, add a persistent data store and shared session/pub-sub layer.

## Rules implemented

- 32 cards (7, 8, 9, 10, J, Q, K, A in ♠ ♦ ♥ ♣); three hands of ten, two cards in the talon. Dealing and first bidder rotate each round.
- **Auction:** ascending 2–7 bids; `Dalje` (pass); senior bidder's `Mogu` priority (matching the top bid); direct **Igra** hand declarations that skip the talon and add one point of game value. In an ordinary auction the winner shows and takes the talon, discards two cards secretly, and chooses any contract at or above the winning bid.
- **Contracts:** Pik (2), Karo (3), Herc (4), Tref (5), Betl (6), Sans (7). Trump contracts require following suit, otherwise playing trump if possible. Betl and Sans follow suit but have no trump. Sans begins with the defender to the declarer's left.
- **Following:** each defender has three distinct buttons: `Dođem` (play), `Ne` (sit out), and `Ne bi` (sit out). The two decline choices have the same game effect, but their exact messages are shown to everyone in the table history and player status. Both defenders automatically play in Betl. A single participating defender may invite the other defender (`Idemo zajedno`) and take responsibility for their collective tricks. With both defenders sitting out of a non-Pik game, the declarer receives all ten tricks automatically.
- **Doubles:** Kontra (×2), Rekontra (×4), Subkontra (×8). Subkontra is the final raise; the stake multiplier cannot exceed ×8. A defender who sat out cannot initiate Kontra, but Kontra calls all three players into the hand. Ordinary Pik needs Kontra to proceed unless new refe cannot be recorded.
- **Tricks:** winner of the trick leads the next; ten tricks per hand; only legal cards may be played. Declarer needs at least six tricks in standard contracts, and **zero** in Betl. Defenders ordinarily need at least two tricks each; an inviting defender needs four total; a doubling defender needs five total.
- **Scoring:** buli for successful/unsuccessful contracts (`± 2 × contract value × stake multiplier`); defending supe for captured tricks; betl fall awards 60 supe to each defender (70 for Igra-Betl), or all to the doubling defender. One unplayed refe doubles the stakes for a declarer's next played contract and is then consumed. Automatic final-score calculation uses **10 × own bula + supe against you − supe earned by you**, so lower is better. If everyone passes, everyone receives a refe where permitted. Finish when aggregate bula reaches zero or below.
- **Private sessions:** each participant receives a random rejoin token stored in their own browser. The server sends only that player's cards. A page refresh automatically rejoins the match. Separate devices should use their own room invites rather than sharing the same saved token.

## House rules and interpretations

The linked rules describe variants and leave some cases unresolved. This implementation uses these consistent choices (including the custom three-button defender replies and the ×8 raise limit):

- Direct hand declarations identify the specific game immediately; **a stronger hand game outranks a weaker hand game and an ordinary bid**. Equal declarations are not allowed, so the first declared hand game wins any tie. No talon is used for hand games.
- `Mogu` priority moves to the next still-bidding player when the holder passes.
- Maximum outstanding refe is configurable (default 2), since the linked rules mention a maximum but don't prescribe its value. A new refe is not awarded once **any player has negative bula**.
- When ordinary Pik is declared without Kontra, the declarer receives a refe if permitted, otherwise it is treated as an automatic success. The rules list variations for this case; this app uses one straightforward option.
- If aggregate bula crosses below zero rather than landing exactly on zero, the match ends. An optional early `otpisivanje` / settlement, negotiated shortcut tricks, forced suit leads by agreement, and penalties for “obvious” strategic mistakes from sections 15–16 are **not automated**.
- Hand games are immediately revealed, and the bidding winner is assigned deterministically without an optional "cede the game and award kontra" convention. The source itself notes ambiguity about equal declarations.

## Tests

Run:

```bash
npm test
```

This checks all major stages, special contracts, priorities, legal trump play, scoring, plus a true end-to-end multiplayer run with an HTTP server and three WebSocket clients (including reconnection and privacy).

## Structure

```text
preferans-online/
├── public/
│   ├── index.html    # Accessible browser page
│   ├── app.js        # Realtime interface and browser WebSocket client
│   └── styles.css    # Responsive card table
├── game.js           # Authoritative rules, trick play, bidding, scores
├── server.js         # HTTP + native WebSocket server / private rooms
├── tests/            # Node tests + real three-client integration
├── render.yaml       # Render deployment blueprint
└── package.json
```

The game is provided as working source code; it is **not hosted** until you run or deploy it.
