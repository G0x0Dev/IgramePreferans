# Preferans — one online table for five friends

Play Preferans in a browser with one shared table for up to five friends (three play each hand, two can watch or wait). Based on the **[Preferans Klub rules, version 1.2](https://www.preferansklub.com/pravila1.htm)**. The game includes private hands, legal move enforcement, real-time WebSockets, automatic scoring and a separate solo practice mode versus two computer players. Share the same site URL with your group; there are no room codes.

## Start on your computer

1. Install [Node.js 22+](https://nodejs.org/). **No `npm install` or database is needed.**
2. Open a terminal inside this folder and run:

   ```bash
   npm start
   ```

3. Open `http://localhost:3000` in your browser. Enter your name and click **Join our table**. There is only one room.
4. Share the website URL with up to **four other friends**. The first three who join get playing seats; the other two may watch or wait. Before a deal, a player can click **Sit out this match** to free a seat for someone else, who clicks **Take an open seat**.
5. Before starting the match, any seated player can choose starting **bula from 50–120 in steps of 10** and maximum outstanding **refe from 2–4**. Defaults are 100 and 2. When all three seats are occupied by online players, one of them clicks **Start match**.

To play over the public internet, deploy the app as described below; `localhost` is for your own computer only.

## Deploy as a real website

### Render (simple option)

1. Upload this entire folder to a new **GitHub repository**. Keep `render.yaml` at the root.
2. In [Render](https://dashboard.render.com/), choose **New → Blueprint**, select that GitHub repository, and approve the web service. Alternatively, choose **New → Web Service**, connect the repository, and set:
   - Runtime: **Node**
   - Build: `npm install` (there are no dependencies)
   - Start: `npm start`
   - Health check: `/health`
3. Render will give you a public HTTPS website such as `https://your-app.onrender.com`. **This is your playable online game URL.** Open it and share its single website link with your group of five.

This project also works on other single-instance Node hosts (Railway, Fly.io, a VPS). The host must support **WebSocket upgrades**, long-lived connections, and the `PORT` environment variable. HTTPS deployments automatically use secure `wss://` WebSockets. No API keys are needed.

**Hosting limitations:** The current match and five-friend roster live in server memory; restart or Render sleep resets the live game and roster. **Finished-match history is saved to `preferans-results.json` (or `HISTORY_FILE` / `DATA_DIR`)**, but **Render Free uses an ephemeral filesystem**, so history files may disappear on redeploy or restart. The website keeps a copy of saved match records in each connected browser and can restore them when server history is empty; friends can also use **Download results backup** and **Restore backup**. Download the JSON backup regularly, and for guaranteed multi-device durability, deploy a durable database or persistent disk. Restored score records are accepted from seated friends; use this with people you trust. Use a single Render instance; horizontal scaling is not supported.

## Solo practice against computer players

On the welcome page, choose **Play solo vs 2 computers** instead of joining the shared table. Enter your name and set bula (50–120) and refe (2–4), then choose **Deal cards · Start practice**. You hold one hand and **Computer 1** and **Computer 2** automatically make legal bids, decide whether to defend or invite a partner, answer Kontra, take/discard the talon and play legal tricks. You still choose your own actions, and can start a new match or restart the current practice at any time.

- Solo practice uses **its own private, temporary server session** (rejoining on refresh is supported). It never joins or occupies the five-friend table.
- **Practice results do not count** towards the shared match history, wins or cumulative leaderboard.
- These are **basic rule-following opponents**, useful for testing the flow and scoring. They are not advanced strategic Preferans AI and may play imperfectly.
- Press **Back to friends** to return to the shared table. Existing friend sessions are kept separately in browser storage.
- Server restarts clear active solo games, just as they clear active multiplayer rounds.

## Rules implemented

- **French-suited playing cards:** 32 cards (7, 8, 9, 10, J, Q, K, A in ♠ ♦ ♥ ♣) with French suit pip layouts, traditional red/black coloring, and decorative J/Q/K court faces; three hands of ten, two cards in the talon. Dealing and first bidder rotate each round. Hands display **one suit at a time, with ranks ascending from 7 to Ace**, in the order **Pik (♠), Karo (♦), Tref (♣), Herc (♥)**. Karo and Herc are separated by Tref; if Tref is absent and Pik is available, Pik sits between the two red suits. Display order refreshes when cards are added or removed.
- **Auction:** ordinary bidding **must follow the exact sequence Pik (2) → Karo (3) → Herc (4) → Tref (5) → Betl (6) → Sans (7)**, one step at a time. Skipping directly from Pik to Tref, for example, is not allowed. Players may still pass or use **Mogu** when eligible. A direct **Igra** declaration can open with any hand contract without bidding Pik first; `Dalje` (pass); senior bidder's `Mogu` priority (matching the top bid); **Igra** hand declarations skip the talon and add one point of game value. In an ordinary auction the winner shows and takes the talon, discards two cards secretly, and chooses any contract at or above the winning bid.
- **Contracts:** Pik (2), Karo (3), Herc (4), Tref (5), Betl (6), Sans (7). Trump contracts require following suit, otherwise playing trump if possible. Betl and Sans follow suit but have no trump. Sans begins with the defender to the declarer's left.
- **Following:** each defender has three distinct buttons: `Dođem` (play), `Ne` (sit out), and `Ne bi` (sit out). The two decline choices have the same game effect, but their exact messages are shown to everyone in the table history and player status. Both defenders automatically play in Betl. A single participating defender may invite the other defender (`Idemo zajedno`) and take responsibility for their collective tricks. **The invited partner cannot call Kontra and cannot earn individual bula or supe for the hand; all defensive scoring belongs to the inviter.** With both defenders sitting out of a non-Pik game, the declarer receives all ten tricks automatically.
- **Doubles:** Kontra (×2), Rekontra (×4), Subkontra (×8). Subkontra is the final raise; the stake multiplier cannot exceed ×8. A defender who sat out or was invited by the other defender cannot initiate Kontra; an eligible defender can still Kontra, which calls all three players into the hand. Ordinary Pik needs Kontra to proceed unless new refe cannot be recorded.
- **Tricks:** winner of the trick leads the next. Standard games (**Pik, Karo, Herc, Tref, Sans**, including Igra and Kontra) **end as soon as both defenders have collected five tricks combined** because the declarer can no longer reach the six needed to pass. Only actually completed tricks count towards defensive **supe**; the declarer still records the normal contract-value **bula** penalty for falling. Do not assume the rest of the ten tricks were won by either side. Otherwise play until ten tricks. **Betl is exempt** and is played to the tenth trick. Defenders ordinarily need at least two tricks each; an inviting defender needs four total; a doubling defender needs five total.
- **Scoring:** buli for successful/unsuccessful contracts (`± 2 × contract value × stake multiplier`); defending supe for captured tricks; betl fall awards 60 supe to each defender (70 for Igra-Betl), or all to the doubling defender. One unplayed refe doubles the stakes for a declarer's next played contract and is then consumed. Automatic final-score calculation uses **10 × own bula + supe against you − supe earned by you**, so lower is better. If everyone passes, everyone receives a refe where permitted. Finish when aggregate bula reaches zero or below.
- **Undo the last card:** the player who last played may request undo within 30 seconds as long as no one has played another card. Both other seated players must separately approve within 20 seconds. Play pauses while they vote; one rejection cancels the request and the original card remains played. An approved undo restores the hand, trick, turn, and any affected score; the player can replay a card. A new deal ends the undo opportunity.
- **Cumulative scores and match history:** finished matches are archived with a date, participant names, and each player's final Preferans score. The sidebar and lobby show cumulative scores, games played, wins and a leaderboard. Lower cumulative scores lead; since players may have played different numbers of matches, compare their games played as well. Results can be exported to JSON or restored from a saved JSON file. Saved records are deduplicated by match ID.
- **One shared table:** five named friends may join from one website URL; only three are seated, with up to two waiting spectators. Members can change seats **before each match**. Spectators can watch public tricks and scores. At the end of a finished match, **Set up next match** returns everyone to the lobby while retaining the friend list. Seated players can free offline entries from the lobby.
- **Private sessions:** each friend receives a random rejoin token stored in their own browser. The server sends only that player’s cards. A page refresh reconnects. A waiting spectator never receives private hands. There is no authentication/password: **anyone who knows the URL can attempt to join**, so this is appropriate for a trusted group, not a secure private club.

## House rules and interpretations

The linked rules describe variants and leave some cases unresolved. This implementation uses these consistent choices (including the custom three-button defender replies and the ×8 raise limit):

- Direct hand declarations identify the specific game immediately; **a stronger hand game outranks a weaker hand game and an ordinary bid**. Equal declarations are not allowed, so the first declared hand game wins any tie. No talon is used for hand games.
- `Mogu` priority moves to the next still-bidding player when the holder passes.
- Maximum outstanding refe is configurable from 2–4 (default 2), since the linked rules mention a maximum but don't prescribe its value. A new refe is not awarded once **any player has negative bula**.
- When ordinary Pik is declared without Kontra, the declarer receives a refe if permitted, otherwise it is treated as an automatic success. The rules list variations for this case; this app uses one straightforward option.
- If aggregate bula crosses below zero rather than landing exactly on zero, the match ends. An optional early `otpisivanje` / settlement, negotiated shortcut tricks, forced suit leads by agreement, and penalties for “obvious” strategic mistakes from sections 15–16 are **not automated**.
- Hand games are immediately revealed, and the bidding winner is assigned deterministically without an optional "cede the game and award kontra" convention. The source itself notes ambiguity about equal declarations.

## Tests

Run:

```bash
npm test
```

This checks all major stages, special contracts, priorities, legal trump play, scoring, plus a live HTTP/WebSocket test with five friends, two waiting spectators, changing seats and settings, reconnection, privacy and scoring.

## Structure

```text
preferans-online/
├── public/
│   ├── index.html    # Accessible browser page
│   ├── app.js        # Realtime interface and browser WebSocket client
│   └── styles.css    # Responsive card table
├── game.js           # Authoritative rules, trick play, bidding, scores
├── server.js         # HTTP + native WebSocket server / one shared room
├── tests/            # Node tests + real three-client integration
├── render.yaml       # Render deployment blueprint
└── package.json
```

The game is provided as working source code; it is **not hosted** until you run or deploy it.
