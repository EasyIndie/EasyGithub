// Create an organization-owned GitHub App from a manifest (the "Option B"
// per-org App used by EasyGithub's zero-file mode).
//
// GitHub has no REST endpoint to create an App, but it does have the manifest
// handshake: a form POST to /organizations/<org>/settings/apps/new, a redirect
// back with a one-time `code`, and POST /app-manifests/<code>/conversions
// which returns the App ID *and* the private key.
//
// This script:
//   1. starts a localhost callback server (127.0.0.1 only),
//   2. prints a URL to open in the browser (auto-submitting form),
//   3. exchanges the code and writes `<out>/<org>.pem` (mode 0600),
//   4. hands the browser to the installation page so the App gets installed.
//
// Usage:
//   node scripts/ghapp-manifest.mjs --org OrzMC --out /tmp/easygh-apps
//
// The private key is never printed. After `--install` completes, store it with
//   gh secret set EASYGH_APP_PRIVATE_KEY_<ORG> -R EasyIndie/EasyGithub < <out>/<org>.pem
// and delete the file.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const org = flag("org", "");
const outDir = resolve(flag("out", ".tmp/ghapp-manifest"));
const port = Number(flag("port", "0"));
const timeoutMs = Number(flag("timeout", "900")) * 1000;

if (!org) {
  console.error("usage: node scripts/ghapp-manifest.mjs --org <Org> [--out dir] [--port 0] [--timeout 900]");
  process.exit(1);
}

const state = randomBytes(24).toString("hex");
const appName = (flag("name", `easygithub-ai-${org.toLowerCase()}`)).slice(0, 34);

function manifestFor(baseUrl, slug) {
  return {
    name: slug,
    url: "https://github.com/EasyIndie/EasyGithub",
    description: "EasyGithub AI pipeline (zero-file App mode, org-owned)",
    public: false,
    redirect_url: `${baseUrl}/callback`,
    setup_url: `${baseUrl}/installed`,
    default_permissions: {
      actions: "read",
      contents: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
      workflows: "write",
    },
    default_events: [],
  };
}

const page = (title, body, script = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:60px auto;padding:0 20px}
code{background:#f4f4f4;padding:2px 5px;border-radius:4px}button,a.btn{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #ccc;background:#f6f8fa;cursor:pointer}
pre{background:#f4f4f4;padding:12px;border-radius:6px;overflow:auto}</style></head>
<body><h2>${title}</h2>${body}${script}</body></html>`;

let finished = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (code, html) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };

  if (url.pathname === "/") {
    const action = `https://github.com/organizations/${org}/settings/apps/new?state=${state}`;
    const manifest = JSON.stringify(manifestFor(actualBase, appName));
    // The browser must POST the manifest; this page does it automatically.
    const auto = `
      <form id="f" action="${action}" method="post">
        <input type="hidden" name="manifest" value='${manifest.replace(/'/g, "&#39;")}'>
        <input type="hidden" name="state" value="${state}">
        <button type="submit" autofocus>Continue to GitHub →</button>
      </form>
      <p>If nothing happens, click the button above (some browsers block auto-submit).</p>
      <script>document.getElementById('f').submit()</script>`;
    send(
      200,
      page(
        `Create the ${org} GitHub App`,
        `<p>You are about to register a <b>private</b> GitHub App owned by <b>${org}</b> with:</p>
         <ul><li>Contents, Issues, Pull requests, Workflows: <b>write</b></li>
             <li>Actions: <b>read</b></li></ul>
         <p>Keep the suggested name (or change it if it is taken), then click <b>Create GitHub App</b>.</p>
         ${auto}`,
      ),
    );
    return;
  }

  if (url.pathname === "/callback") {
    if (url.searchParams.get("state") !== state) return send(400, page("Bad state", "<p>State mismatch.</p>"));
    const code = url.searchParams.get("code");
    if (!code) return send(400, page("Missing code", "<p>GitHub did not return a code.</p>"));
    try {
      const res2 = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res2.ok) throw new Error(`conversion failed: ${res2.status} ${await res2.text()}`);
      const app = await res2.json();
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      const pemFile = join(outDir, `${org}.pem`);
      writeFileSync(pemFile, app.pem, { mode: 0o600 });
      writeFileSync(
        join(outDir, `${org}.app.json`),
        `${JSON.stringify(
          { org, id: app.id, slug: app.slug, html_url: app.html_url, install_url: app.html_url ? `${app.html_url}/installations/new` : "" },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      console.log(`APP_ID=${app.id}`);
      console.log(`APP_SLUG=${app.slug}`);
      console.log(`PEM_FILE=${pemFile}`);
      const install = `https://github.com/apps/${app.slug}/installations/new`;
      console.log(`INSTALL_URL=${install}`);
      send(
        200,
        page(
          "App created — now install it",
          `<p>App <code>${app.slug}</code> (id ${app.id}) was created for <b>${org}</b>.</p>
           <p>Next: install it on the organization and choose <b>All repositories</b>.</p>
           <p><a class="btn" href="${install}">Install ${app.slug} on ${org} →</a></p>
           <script>setTimeout(function(){location.href=${JSON.stringify(install)}},1200)</script>`,
        ),
      );
      return;
    } catch (err) {
      console.error(`CALLBACK_ERROR=${err.message}`);
      send(500, page("Conversion failed", `<pre>${String(err.message)}</pre>`));
      return;
    }
  }

  if (url.pathname === "/installed") {
    const installationId = url.searchParams.get("installation_id") ?? "";
    const action = url.searchParams.get("setup_action") ?? "";
    writeFileSync(join(outDir, `${org}.installed.json`), `${JSON.stringify({ installationId, action }, null, 2)}\n`, { mode: 0o600 });
    console.log(`INSTALLATION_ID=${installationId}`);
    console.log("DONE=1");
    send(
      200,
      page(
        "Installed — you can close this tab",
        `<p>Installation <code>${installationId}</code> registered for <b>${org}</b> (${action}).</p>
         <p>The local helper has stopped. Your hub secrets can now be written.</p>`,
      ),
    );
    finished = true;
    setTimeout(() => server.close(() => process.exit(0)), 500);
    return;
  }

  send(404, page("Not found", "<p>Nothing here.</p>"));
});

let actualBase = "";
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  actualBase = `http://127.0.0.1:${actualPort}`;
  console.log(`OPEN_URL=${actualBase}/`);
  console.log(`ORG=${org}`);
  console.log(`NAME=${appName}`);
});

const timer = setTimeout(() => {
  if (!finished) {
    console.error("TIMEOUT=1");
    server.close(() => process.exit(2));
  }
}, timeoutMs);
timer.unref();

// Convenience: open the browser when requested.
if (args.includes("--open")) {
  const openWhenReady = setInterval(() => {
    if (actualBase.startsWith("http://127.0.0.1:")) {
      clearInterval(openWhenReady);
      try {
        execFileSync("open", [`${actualBase}/`]);
      } catch {
        // user can open the printed URL manually
      }
    }
  }, 100);
}
