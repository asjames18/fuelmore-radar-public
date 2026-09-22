/**
 * Public "coming soon" placeholder for the Planner. The Planner is a future
 * build, not a finished tool: a prediction plan that lays out possibilities —
 * "if you do this, this is the possibility; if you do that, this is the
 * possibility; if you do nothing, this is the possibility" — worked out from
 * current numbers and future numbers. The math behind that is not settled
 * yet, so the public page stays a simple placeholder until the tool is real.
 * The private app keeps its own full Planner.
 */
export function PlannerComingSoon() {
  return <section className="panel guide-page" aria-label="Planner coming soon">
    <div className="panel-heading"><div><h2>Planner</h2><p>Coming soon</p></div></div>
    <div className="guide-body">
      <p><strong>The Planner is a future build.</strong> The idea is a prediction plan: run the possibilities side by side — if you do this, this is the possibility; if you do that, this is the possibility; if you do nothing, this is the possibility — based on current numbers and future numbers.</p>
      <p>Getting that math honest takes real work, so the Planner stays on the drawing board until the numbers can be trusted. It will appear here when it is real.</p>
    </div>
  </section>
}
