// The token radar's model, version radar-2: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks ONLY protocols that pass the observable launch test, the same test the
// snapshot's watchlist applies, extended to every protocol in the file:
//   * it records no token (no market cap, no CoinGecko id, no symbol), and
//   * it is not a wrapped, staked or bridged product of a token that already trades, not a
//     versioned pool of another protocol, and not an exchange itself.
// The snapshot carries no parent-protocol field, so a protocol the house excluded through that
// record alone cannot be detected from the file; the dashboard says so, and such a protocol
// below the floor is left out only when an observable rule above already leaves it out.
// That gives 178 rows: the 40 watchlist protocols plus 138 more below the $50M floor. The
// starter's 200-row board ranked bridged and liquid-staking products as if they were launches;
// this board does not.
//
// Implied value follows only from the snapshot's own figures, never from a hardcoded list of
// names. The category multiple is computed from the snapshot itself: for each category, the
// median market-cap/TVL ratio of the live-token protocols in that category, winsorised at
// 1.0x TVL and shrunk toward the global median with a prior weight of 20 live protocols,
// clamped to [0.10, 0.30]. The shrinkage matters because most categories have only a handful
// of live comparables (one category has a single live protocol at 2.98x); an unshrunk median
// would let one outlier set a whole category's value.
//
//   base       = tvl_usd x category_multiple(category)          (category multiple, see above)
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x 0.6
//   maturity   = 0.65 + min(age_days, 1095) / 1095 x 0.35       (age_days unknown: 365)
//   breadth    = 1 + 0.02 x min(chains - 1, 5)
//   implied    = max(1, round(base x growthMult x maturity x breadth))
//
// Farm plans are derived from the protocol's own record (category, main chain, TVL tier,
// age): eight steps, each with what it costs and how long it takes. Gas bands follow the
// main chain (Ethereum mainnet is dear, L2s and Solana are cheap); no protocol name is ever
// special-cased.

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.205,
  growth_weight: 0.6,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.65,
  maturity_range: 0.35,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** Prior weight (in live protocols) shrinking a category multiple toward the global median. */
export const CATEGORY_PRIOR_WEIGHT = 20;
/** A live FDV/TVL ratio is winsorised at this multiple before any median is taken. */
export const CATEGORY_WINSOR = 1.0;
/** Category multiples are clamped to this range after shrinkage. */
export const CATEGORY_MIN = 0.1;
export const CATEGORY_MAX = 0.3;

/** How many pre-token protocols below the watchlist floor the early radar carries: all that pass the launch test. */
export const EARLY_ROWS = 0; // computed in buildBoard: every rankable protocol below the floor

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    category_multiple: number;
    base_value_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  why: string;
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  base_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  why: string;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface ExcludedSummary {
  live_token: number;
  exchange: number;
  bridged_or_staked: number;
  versioned: number;
  wrapped_name: number;
  /** Pre-token, below the floor, left out by an observable rule above (not the watchlist). */
  other: number;
  top: { slug: string; name: string; category: string | null; tvl_usd: number; reason: string }[];
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  category_multiples: Record<string, number>;
  global_multiple: number;
  excluded: ExcludedSummary;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Median of a sorted array, or `fallback` when empty. */
function medianOf(sorted: number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Category multiples computed from the snapshot itself: for each category, the median
 * winsorised FDV/TVL of its live-token protocols, shrunk toward the global median.
 * Returns the per-category map and the global median used as the prior.
 */
export function categoryMultiples(snapshot: Snapshot): { multiples: Map<string, number>; global: number } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0 || p.category === null) continue; // a $0 market cap is no market value
    const ratio = Math.min(Math.max(p.mcap_usd / p.tvl_usd, 0), CATEGORY_WINSOR);
    all.push(ratio);
    const list = byCategory.get(p.category) ?? [];
    list.push(ratio);
    byCategory.set(p.category, list);
  }
  all.sort((a, b) => a - b);
  const global = medianOf(all, MODEL.base_multiple);
  const multiples = new Map<string, number>();
  for (const [category, ratios] of byCategory) {
    ratios.sort((a, b) => a - b);
    const med = medianOf(ratios, global);
    const shrunk = (ratios.length * med + CATEGORY_PRIOR_WEIGHT * global) / (ratios.length + CATEGORY_PRIOR_WEIGHT);
    multiples.set(category, Math.min(CATEGORY_MAX, Math.max(CATEGORY_MIN, shrunk)));
  }
  return { multiples, global };
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  categoryMultiple: number,
): { implied: number; base: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const breadthMult = 1 + 0.02 * Math.min(Math.max(protocol.chains.length - 1, 0), 5);
  const base = protocol.tvl_usd * categoryMultiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return { implied, base, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories whose product is a wrapped, staked or bridged form of a token that already trades. */
export const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);

const WRAPPED_WORDS = new Set(['wrapped', 'staked', 'staking']);
const EXCHANGE_NAMES = new Set(['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini']);

/** Whether a protocol's name carries a whole wrapped/staked word or begins with an exchange's name. */
export function isWrappedName(p: SnapshotProtocol): boolean {
  const words = p.name.toLowerCase().replace(/-/g, ' ').split(/\s+/);
  if (words.some((w) => WRAPPED_WORDS.has(w))) return true;
  return EXCHANGE_NAMES.has(p.name.split(/\s+/)[0] ?? '');
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a wrapped, staked or bridged product, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !EXCLUDED_CATEGORIES.has(p.category ?? '') && !VERSIONED.test(p.name) && !isWrappedName(p);
}

/** Why a protocol is left off the board, or null when it is rankable. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'live token: its token already trades, shown at its market value';
  if (p.category === 'CEX') return 'exchange: an exchange, not a protocol launch';
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return `bridged or staked product: category ${p.category}`;
  if (VERSIONED.test(p.name)) return 'versioned pool: a numbered release of another protocol';
  if (isWrappedName(p)) return 'wrapped or staked product: its name says so';
  return null;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const { multiples, global } = categoryMultiples(snapshot);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every pre-token protocol below the watchlist floor that passes the launch test.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);
  const scored = [...chosen.values()].map((p) => {
    const catMult = multiples.get(p.category ?? '') ?? global;
    const { implied, base, growthPct, growthMult, maturityMult, breadthMult, age } = impliedValue(p, snapshot.as_of, model, catMult);
    return { p, implied, base, catMult, growthPct, growthMult, maturityMult, breadthMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.slug ? 1 : 0));
  const board = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      category_multiple: round4(s.catMult),
      base_value_usd: Math.round(s.base),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    why: '',
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  for (const row of board) {
    const peers = board.filter((r) => r.category === row.category);
    const tvlRank = board.filter((r) => r.tvl_usd > row.tvl_usd).length + 1;
    const growth = row.change_7d ?? 0;
    if (tvlRank <= 3) row.why = `TVL $${Math.round(row.tvl_usd / 1e6)}M, the ${tvlRank === 1 ? 'largest' : tvlRank === 2 ? 'second-largest' : 'third-largest'} on the board, drives this rank.`;
    else if (growth >= 20) row.why = `Seven-day growth of +${growth.toFixed(1)}% lifts it above larger, slower protocols.`;
    else if (growth <= -30) row.why = `Seven-day TVL fell ${Math.abs(growth).toFixed(1)}%; the rank rests on size and age, not momentum.`;
    else if ((row.age_days ?? 0) >= 1095) row.why = `Running ${(row.age_days! / 365).toFixed(1)} years with no token on record: the longest-running kind of launch candidate.`;
    else if (row.chains.length >= 8) row.why = `Live on ${row.chains.length} chains: the broadest distribution in its range.`;
    else if (peers.length > 0 && row.tvl_usd === Math.max(...peers.map((r) => r.tvl_usd))) row.why = `The largest ${row.category ?? 'protocol'} on the board, in a category whose live tokens trade at ${row.model.category_multiple}x TVL.`;
    else row.why = `Size first: $${Math.round(row.tvl_usd / 1e6)}M of TVL at a ${row.model.category_multiple}x category multiple.`;
  }
  return board;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** Gas for one transaction on a chain, in whole dollars, from the chain's kind. */
function gasFor(chain: string): { amount: number; label: string } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { amount: 9, label: 'about $9 of gas on Ethereum mainnet' };
  if (c === 'solana') return { amount: 0, label: 'under $0.10 of fees on Solana' };
  if (c === 'bitcoin') return { amount: 3, label: 'about $3 of fees on Bitcoin' };
  if (c === 'tron' || c === 'binance' || c === 'bnb chain') return { amount: 1, label: 'about $1 of gas' };
  if (c.includes('l1') || c === 'hyperliquid l1') return { amount: 1, label: 'about $1 of gas' };
  return { amount: 1, label: 'under $1 of gas on an L2' };
}

/** A second, different qualifying action for the category, so the farm is not one deposit. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $${Math.max(25, Math.round(capital / 4))} against the supplied collateral on ${name} and repay it within a week.`;
  if (c.includes('dex')) return `Swap $${Math.max(25, Math.round(capital / 4))} through ${name}'s main pool on ${chain} in the other direction.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return `Deposit $${Math.max(25, Math.round(capital / 4))} into a second ${name} vault or strategy on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${Math.max(25, Math.round(capital / 4))} of a second ${name} yield asset on ${chain}.`;
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('perps')) return `Open one small hedge on ${name} with $${Math.max(25, Math.round(capital / 4))} of margin, then close it.`;
  if (c.includes('prediction')) return `Place a second, smaller market position on ${name}.`;
  if (c.includes('launchpad')) return `Join ${name}'s allowlist or stake for an allocation on ${chain}.`;
  if (c.includes('bridge')) return `Bridge a small amount back through ${name} and use it in the destination app.`;
  return `Use a second feature of ${name} on ${chain}: a swap, a vote or a second deposit of $${Math.max(25, Math.round(capital / 4))}.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL and age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const secondCapital = Math.max(25, Math.round(capital / 4));
  return [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'nothing to set up', time: '5 minutes' },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and ${gas.label}`, time: '15 minutes to set up' },
    { text: secondActionFor(p, capital, chain), cost: `$${secondCapital} of capital and ${gas.label}`, time: '10 minutes' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: `${gas.label} a week`, time: '10 minutes a week' },
    { text: `Open the protocol's own points or rewards page, if it publishes one, and finish any quest it lists.`, cost: 'no fee to check', time: '10 minutes' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: `Follow the protocol's official announcements and vote if a governance proposal opens; never pay to claim and never follow a claim link sent in a direct message.`, cost: 'nothing', time: '5 minutes a week' },
    { text: `Before you withdraw, claim only from the link the protocol itself publishes, then unwind in stages and write the wallet, the dates and every transaction in a farm log.`, cost: `${gas.label} to unwind`, time: '10 minutes' },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    base_value_usd: row.model.base_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    why: row.why,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const { multiples, global } = categoryMultiples(snapshot);
  const onBoard = new Set(board.map((r) => r.slug));
  const excluded: ExcludedSummary = { live_token: 0, exchange: 0, bridged_or_staked: 0, versioned: 0, wrapped_name: 0, other: 0, top: [] };
  const excludedRows: { slug: string; name: string; category: string | null; tvl_usd: number; reason: string }[] = [];
  for (const p of snapshot.protocols) {
    if (onBoard.has(p.slug)) continue;
    const reason = exclusionReason(p);
    if (reason === null) { excluded.other += 1; excludedRows.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: 'left out by the house watchlist rule through its parent-protocol record, which this snapshot does not carry' }); continue; }
    if (!isPreToken(p)) excluded.live_token += 1;
    else if (p.category === 'CEX') excluded.exchange += 1;
    else if (EXCLUDED_CATEGORIES.has(p.category ?? '')) excluded.bridged_or_staked += 1;
    else if (VERSIONED.test(p.name)) excluded.versioned += 1;
    else if (isWrappedName(p)) excluded.wrapped_name += 1;
    else excluded.other += 1;
    excludedRows.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
  }
  excluded.top = excludedRows.sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 12);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
    category_multiples: Object.fromEntries([...multiples.entries()].sort()),
    global_multiple: Math.round(global * 10000) / 10000,
    excluded,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
