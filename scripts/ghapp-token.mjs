// Mint a GitHub App installation token for the given org and export it as
// GH_TOKEN via $GITHUB_ENV (so later steps use it). Uses Node built-ins only.
//
// env: EASYGH_APP_ID, EASYGH_APP_PRIVATE_KEY (secret), ORG (default EasyIndie)
import { readFileSync, appendFileSync } from "node:fs";
import { createSign } from "node:crypto";

const appId = process.env.EASYGH_APP_ID;
const keyPem = process.env.EASYGH_APP_PRIVATE_KEY;
const org = process.env.ORG ?? "EasyIndie";
if (!appId || !keyPem) {
  console.error("missing EASYGH_APP_ID or EASYGH_APP_PRIVATE_KEY");
  process.exit(1);
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64u({ alg: "RS256", typ: "JWT" });
const payload = b64u({ iat: now - 60, exp: now + 540, iss: appId });
const sign = createSign("RSA-SHA256");
sign.update(`${header}.${payload}`);
sign.end();
const jwt = `${header}.${payload}.${sign.sign(keyPem, "base64url")}`;

const A = "application/vnd.github+json";
const auth = { Authorization: `Bearer ${jwt}`, Accept: A };

const listRes = await fetch("https://api.github.com/app/installations", { headers: auth });
if (!listRes.ok) {
  console.error(`list installations failed: ${listRes.status}`);
  process.exit(1);
}
const installs = await listRes.json();
const inst = (Array.isArray(installs) ? installs : []).find((i) => i.account?.login === org);
if (!inst) {
  console.error(`no installation found for org ${org}`);
  process.exit(1);
}

const tokRes = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
  method: "POST",
  headers: auth,
});
if (!tokRes.ok) {
  console.error(`create access token failed: ${tokRes.status}`);
  process.exit(1);
}
const tok = await tokRes.json();

if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `GH_TOKEN=${tok.token}\n`);
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `token=${tok.token}\n`);
  console.log(`ghapp-token: installation ${inst.id} on ${org}; token written to outputs`);
} else if (!process.env.GITHUB_ENV) {
  console.log(tok.token); // local usage only
}
