const core = require("@actions/core");
const github = require("@actions/github");
const { execSync } = require("child_process");
const https = require("https");
const fs = require("fs");

function getLatestTag() {
  try {
    return execSync("git describe --tags --abbrev=0 2>/dev/null", { encoding: "utf8" }).trim();
  } catch {
    // No tags — use first commit
    return execSync("git rev-list --max-parents=0 HEAD", { encoding: "utf8" }).trim();
  }
}

function getCommits(fromRef, toRef, maxCommits) {
  const format = "%H|||%s|||%b|||%an|||%ae|||%aI";
  const output = execSync(
    `git log ${fromRef}..${toRef} --format="${format}" --no-merges -n ${maxCommits}`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );

  return output.split("\n").filter(Boolean).map((line) => {
    const [hash, subject, body, author, email, date] = line.split("|||");
    return { hash: hash?.trim(), subject: subject?.trim(), body: body?.trim(), author: author?.trim(), email: email?.trim(), date: date?.trim() };
  });
}

function getMergeCommits(fromRef, toRef) {
  try {
    const output = execSync(
      `git log ${fromRef}..${toRef} --merges --format="%s" -n 200`,
      { encoding: "utf8" }
    );
    const prNumbers = [];
    for (const line of output.split("\n")) {
      const match = line.match(/Merge pull request #(\d+)/);
      if (match) prNumbers.push(parseInt(match[1]));
    }
    return prNumbers;
  } catch {
    return [];
  }
}

async function fetchPRDetails(octokit, owner, repo, prNumbers) {
  const details = [];
  for (const num of prNumbers.slice(0, 50)) {
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: num });
      details.push({
        number: num,
        title: data.title,
        body: data.body || "",
        labels: data.labels.map((l) => l.name),
        author: data.user.login,
      });
    } catch { /* ignore */ }
  }
  return details;
}

function callOpenAI(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a technical writer who creates clear, polished release notes. You organize changes by category, highlight breaking changes prominently, and write in a way that both developers and non-technical users can understand." },
        { role: "user", content: prompt },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    });

    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callAnthropic(apiKey, model, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      system: "You are a technical writer who creates clear, polished release notes. You organize changes by category, highlight breaking changes prominently, and write in a way that both developers and non-technical users can understand.",
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function buildPrompt(commits, prDetails, audience, repoName, fromRef, toRef) {
  const commitSummary = commits.slice(0, 100).map((c) =>
    `- ${c.subject}${c.body ? " | " + c.body.substring(0, 100) : ""}`
  ).join("\n");

  const prSummary = prDetails.map((pr) =>
    `- PR #${pr.number}: ${pr.title} (by @${pr.author})${pr.labels.length ? " [" + pr.labels.join(", ") + "]" : ""}`
  ).join("\n");

  let audienceInstruction = "";
  if (audience === "users") {
    audienceInstruction = "Write for non-technical end users. Focus on visible features, fixes, and improvements. Avoid technical jargon.";
  } else if (audience === "developers") {
    audienceInstruction = "Write for developers. Include technical details, API changes, and migration notes.";
  } else {
    audienceInstruction = "Write for both developers and end users. Start with a user-friendly summary, then include technical details.";
  }

  return `Generate polished release notes for **${repoName}** (${fromRef} → ${toRef}).

${audienceInstruction}

## Structure the output as:
1. **Headline** — One-line summary of this release
2. **⚠️ Breaking Changes** — If any (prominently displayed)
3. **✨ New Features** — New capabilities
4. **🐛 Bug Fixes** — Issues resolved
5. **🔧 Improvements** — Performance, DX, refactors
6. **📦 Dependencies** — Dependency updates (brief)
7. **📝 Notes** — Migration instructions if needed

## Raw commit history:
${commitSummary}

## Pull requests:
${prSummary || "No PR data available"}

Rules:
- Group related commits together
- Don't just repeat commit messages — synthesize them
- Highlight breaking changes at the top
- Use markdown formatting
- Be concise but informative
- Skip trivial commits (typo fixes, merge commits) unless they fix user-facing issues`;
}

async function run() {
  const provider = core.getInput("ai-provider");
  const apiKey = core.getInput("api-key");
  const model = core.getInput("model");
  let fromRef = core.getInput("from-ref");
  const toRef = core.getInput("to-ref") || "HEAD";
  const outputFile = core.getInput("output-file");
  const includePRLinks = core.getInput("include-pr-links") === "true";
  const audience = core.getInput("audience");
  const maxCommits = parseInt(core.getInput("max-commits")) || 200;
  const token = core.getInput("github-token");

  if (!fromRef) {
    fromRef = getLatestTag();
    core.info(`Auto-detected from-ref: ${fromRef}`);
  }

  core.info(`Generating release notes: ${fromRef}..${toRef}`);

  const commits = getCommits(fromRef, toRef, maxCommits);
  core.info(`Found ${commits.length} commits`);

  if (commits.length === 0) {
    core.warning("No commits found in range");
    fs.writeFileSync(outputFile, "# Release Notes\n\nNo changes in this release.\n");
    core.setOutput("release-notes", "No changes in this release.");
    core.setOutput("output-path", outputFile);
    return;
  }

  // Fetch PR details
  let prDetails = [];
  if (includePRLinks && token) {
    const octokit = github.getOctokit(token);
    const prNumbers = getMergeCommits(fromRef, toRef);
    if (prNumbers.length > 0) {
      prDetails = await fetchPRDetails(octokit, github.context.repo.owner, github.context.repo.repo, prNumbers);
    }
  }

  const repoName = `${github.context.repo.owner}/${github.context.repo.repo}`;
  const prompt = buildPrompt(commits, prDetails, audience, repoName, fromRef, toRef);

  core.info(`Calling ${provider} (${model})...`);
  let releaseNotes;
  if (provider === "openai") {
    releaseNotes = await callOpenAI(apiKey, model, prompt);
  } else if (provider === "anthropic") {
    releaseNotes = await callAnthropic(apiKey, model, prompt);
  } else {
    core.setFailed(`Unknown AI provider: ${provider}`);
    return;
  }

  fs.writeFileSync(outputFile, releaseNotes);
  core.setOutput("release-notes", releaseNotes);
  core.setOutput("output-path", outputFile);

  core.summary.addHeading("📝 AI Release Notes Generated", 2);
  core.summary.addRaw(`**Range:** ${fromRef}..${toRef} | **Commits:** ${commits.length} | **PRs:** ${prDetails.length}\n\n`);
  core.summary.addRaw(releaseNotes);
  await core.summary.write();
}

run().catch((error) => core.setFailed(error.message));
