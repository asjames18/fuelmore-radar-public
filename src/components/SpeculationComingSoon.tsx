/**
 * "Coming soon" placeholder for the Speculation view. The goal is a real
 * forward-looking view — future price, supply, burn, and liquidity projections
 * built with predictive math from what is currently happening on-chain
 * (current state → future state, recomputed as new numbers come in). The
 * scenario extrapolations that shipped earlier couldn't run without their
 * underlying reads and weren't the predictive view this is meant to be, so
 * the page stays a simple placeholder until the math is figured out.
 */
export function SpeculationComingSoon() {
  return <section className="panel guide-page" aria-label="Speculation coming soon">
    <div className="panel-heading"><div><h2>Speculation</h2><p>Coming soon</p></div></div>
    <div className="guide-body">
      <p><strong>Speculation is a future build.</strong> The idea is forward-looking projections — future price, future supply, future burns, future liquidity — built with predictive math from what is currently happening: today's on-chain state projected into future state, updated as new numbers come in.</p>
      <p>That math isn't figured out yet, so this page stays on the drawing board until the projections are real and trustworthy. It will appear here when it is.</p>
    </div>
  </section>
}
