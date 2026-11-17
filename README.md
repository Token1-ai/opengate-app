# OpenGate

Web3 social platform: wallet instead of an account, posts, likes, direct messages,
groups, an NFT marketplace, an NFT creation studio, a token creator and PvP games
played for real money. Live on BNB Chain, Polygon, Base and Arbitrum.

Companion repository: **LaunchLab** (token launchpad and trading pools) —
`Token1-ai/launchpad.html`, served at launchlab.opengate.bond.

---

## How the project is laid out

There is no build step. The site is plain HTML, CSS and JavaScript served as static
files, plus serverless functions. Edit a file, push, Vercel deploys it.

```
index.html      the entire site: landing page + the app (~1 MB, one file)
launchpad.html  older standalone launchpad page, kept for the old links
sw.js           service worker, makes the site installable as a phone app
manifest.json   app icon and name for the phone
wc.js           WalletConnect helper
api/            serverless functions (Vercel)
```

### `api/` — what each function does

| File | What it does |
| --- | --- |
| `oracle.js`, `oracle-gold.js` | settle Battleship results on BNB Chain |
| `oracle-polygon.js`, `oracle-gold-polygon.js` | the same on Polygon |
| `oracle-base.js`, `oracle-gold-base.js` | the same on Base |
| `pass-voucher.js` | signs proof of pass ownership for chains that cannot read BNB Chain |
| `admin-moderate.js` | moderation: hide posts, ban wallets |
| `filebase-upload.js` | hands the browser a short-lived upload token |
| `nft-meta.js`, `nft-proxy.js` | read NFT metadata and images |
| `rpc.js` | proxies blockchain calls so paid node keys are not exposed |

### Inside `index.html`

One file, in this order: styles, the landing page, the app views, then the
JavaScript. To find your way around, search for these markers:

- `const LITVM`, `const BNB`, `const POLYGON` — network settings
- `window.OPENGATE_OWNER` — the platform owner's wallet, set in one place
- `GOLD_PASS`, `SILVER_PASS`, `NFT_MARKET_BNB`, `TOKEN_FACTORY_BNB` … — contract addresses
- `const LANGS` — all interface text in seven languages
- `function showTab(` — switches between app views
- `async function dmCall(` — private messages, handled server-side

---

## Contracts

All addresses are on mainnet unless marked otherwise.

### BNB Chain

| Contract | Address |
| --- | --- |
| Gold Pass | `0x4D26Ec2f8edbb3F567953CC7573FF60cA009258c` |
| Silver Pass | `0xeaDF62931f8ef2Ec546E77fBC5E56F1B3157Af89` |
| Token factory | `0xcC072333E5d43E2521F7C5a0da26312a3E44b2ff` |
| NFT factory | `0xAAeffd9dC63e8E59c1865bd42f054b83a6998224` |
| NFT marketplace | `0x78D7211915D15446230f3Fb0cC8469cD57Aa29Bf` |
| Battleship | `0xa51bc530BCa50D8D658f5c185156904fFBe41994` |
| Gold Battleship | `0x7a2808690be859aD786dC3C43001d42550f39BEF` |

### Polygon

| Contract | Address |
| --- | --- |
| Token factory | `0x3E345EF72d29D9e46E1E713b3d4f7AEf8b02E453` |
| NFT factory | `0x3229Ed7458EDf915113C70bE1BcfcAA08869C51C` |
| NFT marketplace | `0x73b149defe4164484d3da166cAFB75d2CB40d997` |
| Battleship | `0x9E723b339dA57f046435239dac168003f90B1B20` |
| Gold Battleship | `0xb21482cFd2b5A7a35A85fF4193501CDEDFDdB7dd` |

### Base

| Contract | Address |
| --- | --- |
| Token factory | `0xB11D6faE283a8aa6D815Ad6Dc3ec953E4A037143` |
| NFT factory | `0x3eCad12b461931f78f4237660dADc068f89C6b49` |
| NFT marketplace | `0xba774172f7bb0a2E9BEc9B53D7a55267A3107F5E` |
| Battleship | `0xc4844EBDACE533D7b98C730ad06aF57376eCbf12` |
| Gold Battleship | `0x2b7b9d98404Fa0b5F0ffcAB89387373B98268acE` |

### Arbitrum

| Contract | Address |
| --- | --- |
| Token factory | `0xeaDF62931f8ef2Ec546E77fBC5E56F1B3157Af89` |
| NFT factory | `0xB11D6faE283a8aa6D815Ad6Dc3ec953E4A037143` |
| NFT marketplace | `0x73b149defe4164484d3da166cAFB75d2CB40d997` |

### zkLitVM — testnet, not mainnet

The GATE token and everything around it run on the zkLitVM LiteForge **testnet**.
That network is migrating from Caldera to Zeeve and its old endpoints are down, so
these features are temporarily out of order. The site says so on every affected page.

| Contract | Address |
| --- | --- |
| GATE token | `0xf383B2e7ad25D3f7f9cEcB68f4fe60049a3Ee8af` |
| Staking | `0x4c1B51bbef77344B7671E94082E032a62237737A` |
| Presale | `0xd1BD1853913F1CA242cD4D88a1F50EB0a6ba0854` |
| Faucet | `0xCF2B61D76F2140D8270e612918DEE1501EcC637C` |
| Lending | `0x05007cA22f2e86Ffe8eF2fE3B19b323A5B4B01F6` |
| Dice | `0x5c2279eC7f2A0b717f2EDff068cD2bC65C79D855` |
| Lottery | `0xfc5AFcF1dEa493d61E981B1D08519dd1a7d78035` |
| Battleship | `0xB11D6faE283a8aa6D815Ad6Dc3ec953E4A037143` |

**Ownership transfer.** Every contract uses a two-step handover: the current owner
calls `transferOwnership(newWallet)`, then the new owner calls `acceptOwnership()`
from their own wallet. Control only moves once the second call succeeds, so a
mistyped address cannot lose a contract.

**Never call `renounceOwnership`.** It does not transfer ownership — it destroys it.
The contract is left with no owner and no way to appoint one.

---

## Settings (Vercel → Settings → Environment Variables)

| Name | What it is for |
| --- | --- |
| `PLATFORM_OWNER` | the owner's wallet: moderation rights, no limits, advertising income |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | database access for the serverless functions |
| `ORACLE_PRIVATE_KEY` | signs game results; must hold a little gas on each chain |
| `ATTESTOR_PRIVATE_KEY` | signs pass proofs for Polygon, Base and Arbitrum |
| `PINATA_JWT` | image storage |
| `FILEBASE_KEY`, `FILEBASE_SECRET` | image storage |
| `GOLD_PASS_CONTRACT`, `SILVER_PASS_CONTRACT` | only if new passes are issued |
| `ALCHEMY_*_RPC` | paid blockchain nodes; public ones are used if these are unset |

After changing any of these press **Redeploy**, otherwise the old values stay live.

---

## Database

Supabase (PostgreSQL). The tables this project uses:

`users`, `posts`, `comments`, `likes`, `follows`, `messages`, `dm_sessions`,
`notifications`, `groups`, `group_members`, `group_messages`, `group_polls`,
`group_poll_votes`, `group_message_likes`, `group_message_reactions`,
`battleship_games`, `battleship_boards`, `banned_wallets`, `reports`,
`hidden_nfts`, `pinata_key_log`.

Private messages are closed at the database level: the browser cannot read the
`messages` table directly. All of it goes through the `dm` edge function, which
checks who is asking. Edge functions live in Supabase → Edge Functions:
`dm`, `group-action`, and one per chain for the games.

A nightly job (`trim_old_trades`, 03:17 UTC) keeps 90 days of trade history in full
and thins anything older down to one record per hour.

---

## Running it

Locally, any static server will do — but the serverless functions in `api/` will not
run, so anything that needs them (games, moderation, uploads, private messages) will
not work:

```bash
npx serve .
```

To run it properly, with the functions:

```bash
npm i -g vercel
vercel dev
```

Deployment is automatic: push to `main` and Vercel builds it. There is nothing to
compile.

---

## Known limitations

- **No security audit.** No outside firm has reviewed the contracts.
- **The zkLitVM half is down** while that testnet migrates to a new provider.
- **Game results are settled by a server key**, not decided inside the contract.
- **The Alchemy keys in `index.html` are visible to anyone** who opens the site.
  Replace them with your own before you rely on them.
