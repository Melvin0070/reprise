// The decision half of the 6PN deploy preflight (issue #79).
//
// Reads one envelope of Fly listings on stdin and answers a single question
// with an exit code: is anything reachable over this organization's private
// network besides the sandbox app itself?
//
//   0  clear      1  the org holds a peer      2  cannot tell, refusing
//
// The 2 is the load-bearing one. `fly apps list --json` is a CLI output format,
// not a versioned contract, and two of the three listings here are not JSON at
// all -- `fly redis list` prints a table and `fly mpg list -j` prints prose when
// empty. So every branch below that does not recognise its input exits 2 rather
// than assuming the best. A guard that reads "I could not tell" as "all clear"
// is worse than no guard, because it gets trusted; one that refuses is a loud
// deploy failure someone diagnoses in a minute.
//
// Kept separate from preflight-org.sh, which collects the listings, so this
// decision is a pure function of its input and testable with no Fly account,
// no credentials and no network (infra/preflight-org.test.sh).

const CLEAR = 0;
const PEER_FOUND = 1;
const CANNOT_TELL = 2;

// `fly redis list` has no --json, so its empty form is a table header and
// nothing else. Matching the header exactly means a flyctl change to these
// columns refuses rather than silently reading a populated table as empty.
const REDIS_HEADER = [
  "NAME",
  "ORG",
  "PLAN",
  "EVICTION",
  "PRIMARY REGION",
  "READ REGIONS",
];

const MPG_EMPTY = /^No managed postgres clusters found in organization\b/u;

class RefuseError extends Error {
  constructor(message) {
    super(message);
    this.name = "RefuseError";
  }
}

const refuse = (why) => {
  throw new RefuseError(why);
};

const nonBlankLines = (raw) =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

// `fly orgs list --json` maps slug -> display name. If the target org is not in
// it, this credential is not looking at the organization we are reasoning
// about, and every listing below describes somewhere else.
const checkOrgVisible = (orgs, org) => {
  if (typeof orgs !== "object" || orgs === null || Array.isArray(orgs)) {
    refuse("`fly orgs list --json` was not an object");
  }
  if (!Object.hasOwn(orgs, org)) {
    refuse(
      `this credential cannot see the "${org}" organization, so it cannot ` +
        "establish what is on its private network"
    );
  }
};

// Container apps. This is the only listing that is honest JSON, and it is also
// the one that does NOT cover managed add-ons -- see the redis and mpg checks.
const appPeers = (apps, { app, org }) => {
  if (!Array.isArray(apps)) {
    refuse("`fly apps list --json` was not an array");
  }
  if (!apps.every((entry) => entry && typeof entry.Name === "string")) {
    refuse("an entry from `fly apps list --json` had no string Name");
  }
  // `fly apps list` spans every org the user belongs to unless --org is passed.
  // The collector passes it; this re-checks, because a listing that carries a
  // foreign org means the scoping did not take and the peer set is wrong.
  const foreign = apps.filter(
    (entry) => entry.Organization && entry.Organization.Slug !== org
  );
  if (foreign.length > 0) {
    refuse(
      `the app listing carried apps from another organization (${foreign
        .map((entry) => entry.Organization.Slug)
        .join(", ")}), so it is not scoped to "${org}"`
    );
  }
  // The positive claim has to be earned. An app-scoped token, or a listing of
  // the wrong org, returns a well-formed array that simply does not contain the
  // sandbox app -- and reporting "alone in the org" from that is asserting
  // something the input never said.
  if (!apps.some((entry) => entry.Name === app)) {
    refuse(
      `"${app}" was not in the app listing, so this is not a view of the ` +
        "organization it is deployed to"
    );
  }
  return apps.map((entry) => entry.Name).filter((name) => name !== app);
};

// Upstash Redis is an add-on under a different GraphQL root field than apps, so
// `fly apps list` cannot see it -- and Fly gives it "a private IPv6 address
// restricted to your Fly organization", which is to say it is exactly the kind
// of 6PN peer this preflight exists to find.
const redisPeers = (raw) => {
  if (typeof raw !== "string") {
    refuse("the redis listing was not text");
  }
  const lines = nonBlankLines(raw);
  if (lines.length === 0) {
    refuse("`fly redis list` printed nothing, not even a header");
  }
  const header = lines[0]
    .split("│")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
  if (header.join("|") !== REDIS_HEADER.join("|")) {
    refuse(
      "`fly redis list` did not print the header this check knows; its " +
        "output format changed and the empty case can no longer be recognised"
    );
  }
  return lines.slice(1).map((line) => line.split("│")[0].trim());
};

// Managed Postgres runs inside the private network -- Fly's own docs say it is
// "not accessible over the public internet", and `fly mpg proxy` reaches it at
// an fdaa:: address. `fly mpg list -j` prints prose rather than `[]` when the
// org holds none, so both shapes are accepted and nothing else is.
const mpgPeers = (raw) => {
  if (typeof raw !== "string") {
    refuse("the managed-postgres listing was not text");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    refuse("`fly mpg list -j` printed nothing");
  }
  if (MPG_EMPTY.test(trimmed)) {
    return [];
  }
  let clusters;
  try {
    clusters = JSON.parse(trimmed);
  } catch {
    refuse("`fly mpg list -j` was neither its empty message nor JSON");
  }
  if (!Array.isArray(clusters)) {
    refuse("`fly mpg list -j` was JSON but not an array");
  }
  return clusters.map((cluster, i) =>
    typeof cluster?.name === "string" ? cluster.name : `cluster #${i + 1}`
  );
};

const decide = (envelope) => {
  const { org, app, orgs, apps, redis, mpg } = envelope;
  if (typeof org !== "string" || typeof app !== "string") {
    refuse("the envelope named no org and app");
  }
  checkOrgVisible(orgs, org);
  return [
    ...appPeers(apps, { app, org }).map((name) => `app        ${name}`),
    ...redisPeers(redis).map((name) => `redis      ${name}`),
    ...mpgPeers(mpg).map((name) => `postgres   ${name}`),
  ];
};

const main = (raw) => {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    process.stderr.write("PREFLIGHT REFUSED: the envelope was not JSON.\n");
    return CANNOT_TELL;
  }
  let peers;
  try {
    peers = decide(envelope);
  } catch (error) {
    if (!(error instanceof RefuseError)) {
      throw error;
    }
    process.stderr.write(`PREFLIGHT REFUSED: ${error.message}.\n`);
    process.stderr.write(
      "  Refusing rather than assuming the org is clear. See issue #79.\n"
    );
    return CANNOT_TELL;
  }
  if (peers.length > 0) {
    process.stderr.write(
      `PREFLIGHT FAIL: the Fly org holds ${peers.length} resource(s) beside ` +
        `${envelope.app}:\n`
    );
    for (const peer of peers) {
      process.stderr.write(`  - ${peer}\n`);
    }
    process.stderr.write(
      "\n  Everything in a Fly org shares one private network, so each of these\n" +
        "  is reachable from inside the crude-tier sandbox with no escape\n" +
        "  required. Either move the sandbox to a dedicated network (issue #88)\n" +
        "  or remove these before deploying. See docs/threat-model.md.\n"
    );
    return PEER_FOUND;
  }
  process.stdout.write(
    `preflight ok: no app, Upstash Redis or Managed Postgres in "${envelope.org}" ` +
      `beside ${envelope.app}.\n`
  );
  return CLEAR;
};

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  // process.exitCode rather than process.exit(): writes to a pipe are async, and
  // exiting truncates the peer list at the pipe buffer -- the exit code would
  // survive but the names an operator acts on would not.
  process.exitCode = main(input);
});
