/**
 * Public "How to use the Radar" guide. Plain-language tour of every page:
 * what it shows, how to use it, and how to read the numbers honestly.
 * No data fetching here — keep it static so it never breaks.
 */
export function Guide() {
  return <div className="guide-page">
    <section className="panel" aria-labelledby="guide-what">
      <div className="panel-heading"><div>
        <h2 id="guide-what">What the Radar is</h2>
        <p>The one-minute version</p>
      </div></div>
      <div className="guide-body">
        <p>
          The FUEL/MORE Radar is a read-only dashboard for the FUEL and MORE tokens on
          Robinhood Chain (chain ID 4663). It shows prices, liquidity, protocol activity,
          and wallet positions from public on-chain data.
        </p>
        <p>
          There is no wallet connection and no trading here. To look up a wallet you paste
          its address — that is the only thing we ever ask for. Numbers refresh about
          every 15 minutes, and every value carries its own timestamp so you can see how
          fresh it is. Nothing on this site is financial advice.
        </p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-overview">
      <div className="panel-heading"><div>
        <h2 id="guide-overview">Overview — the market, right now</h2>
        <p>Start here</p>
      </div></div>
      <div className="guide-body">
        <p>
          Token cards show live price, liquidity, and 24-hour change for FUEL and MORE.
          Daily pulse tracks minting and claiming wallets today and over the last
          seven days, and upcoming maturities lists MORE vesting in the next few
          days. When a value is unavailable we show it as missing instead of
          guessing.
        </p>
        <p>
          Recent activity lists the latest on-chain transfers for both tokens, each
          linked to the block explorer.
        </p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-markets">
      <div className="panel-heading"><div>
        <h2 id="guide-markets">Markets — how deep is the water</h2>
        <p>Before you size anything</p>
      </div></div>
      <div className="guide-body">
        <p>
          Price alone is not executable liquidity. The pool table shows market cap,
          24-hour buys and sells, and the pool address behind each price, with links
          out to Dexscreener. Top holders shows how concentrated each token is.
        </p>
        <p>Check here before assuming you can move size without moving the price.</p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-protocol">
      <div className="panel-heading"><div>
        <h2 id="guide-protocol">Protocol — how healthy is the machine</h2>
        <p>The system behind the tokens</p>
      </div></div>
      <div className="guide-body">
        <p>
          Protocol stats track the system's vital signs. The fee flow shows where
          protocol fees go. Minting vs claiming charts show FUEL activity over time.
        </p>
        <p>
          The fee quote tool gives you a view-only on-chain mint fee for a batch size
          you enter — a quote for planning, never a transaction.
        </p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-cockpit">
      <div className="panel-heading"><div>
        <h2 id="guide-cockpit">Cockpit — your positions, no connection needed</h2>
        <p>One page, two tools</p>
      </div></div>
      <div className="guide-body">
        <p>
          <strong>Positions tab.</strong> Paste any wallet address to read its public
          positions: active mints, a maturity calendar, MORE positions, and batch mint
          slots. You can save wallets to a watchlist — it lives only in your browser,
          never on our servers.
        </p>
        <p>
          <strong>Inventory & claims tab.</strong> The deep read on FUEL: mint inventory, next
          maturity, due and late counts, claim estimates grouped by unlock day, and an
          "if you claim and sell now" model that sizes a sale against pool depth.
        </p>
        <p>
          Both tools are indicative. USD values use a pool price snapshot, not an
          executable quote — open the linked pool to see live depth. We will never ask
          you to connect a wallet. If something claiming to be the Radar does, it is
          not us.
        </p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-contracts">
      <div className="panel-heading"><div>
        <h2 id="guide-contracts">Contracts — trust, then verify</h2>
        <p>The address is the identity</p>
      </div></div>
      <div className="guide-body">
        <p>
          Every contract address the Radar reads, in one registry with copy buttons.
          One warning worth memorizing: FUEL on Robinhood Chain is <em>not</em> Fuel
          Network's FUEL token — same ticker, different chain, different token.
        </p>
        <p>Always check the address, not the name.</p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-speculation">
      <div className="panel-heading"><div>
        <h2 id="guide-speculation">Speculation — what today's pace implies</h2>
        <p>Supply, burn, price, and liquidity scenarios from live numbers</p>
      </div></div>
      <div className="guide-body">
        <p>
          Speculation extends numbers you can verify right now: current supply
          from <code>totalSupply()</code>, burns to date from the burn
          controllers, the known mint-maturity schedule, the trailing mint and
          claim pace, the on-chain mint fee, the verified 25% / 30% fee
          split, plus the current market-cap and pool-liquidity snapshots.
          Every assumption is listed on the page.
        </p>
        <p>
          These are scenarios — "if today's on-chain pace continued" — not
          predictions, not price calls, and not advice. Price lines are pure
          arithmetic (today's market cap ÷ projected supply); real prices are
          set by markets this radar does not model. The individual Planner
          stays on the drawing board until its math can be trusted.
        </p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-planner">
      <div className="panel-heading"><div>
        <h2 id="guide-planner">Planner — coming soon</h2>
        <p>Prediction plans, not yet</p>
      </div></div>
      <div className="guide-body">
        <p>
          The Planner is a future build: run the possibilities side by side —
          if you do this, this is the possibility; if you do that, this is the
          possibility; if you do nothing, this is the possibility — worked out
          from current numbers and future numbers. It stays on the drawing
          board until the math can be trusted.
        </p>
      </div>
    </section>

    <section className="panel" aria-labelledby="guide-numbers">
      <div className="panel-heading"><div>
        <h2 id="guide-numbers">Reading the numbers like a local</h2>
        <p>Three rules</p>
      </div></div>
      <div className="guide-body">
        <p>
          <strong>Every value has a timestamp.</strong> "Delayed" or "stale" labels
          mean exactly what they say — check the timestamp beside any number that
          matters to you.
        </p>
        <p>
          <strong>A failed read is never a zero.</strong> If we cannot read something
          we show "unavailable." A zero would be a lie; unavailable is the truth.
        </p>
        <p>
          <strong>Third-party figures are snapshots.</strong> Dexscreener numbers are a
          third party's mirror of on-chain pools — useful context, not executable
          quotes.
        </p>
      </div>
    </section>
  </div>
}
