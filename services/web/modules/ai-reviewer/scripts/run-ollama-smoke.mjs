/* eslint-disable @overleaf/require-script-runner */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import Path from "node:path";
import { fileURLToPath } from "node:url";

import { OllamaOpenAiTransport } from "../app/src/OllamaOpenAiTransport.mjs";

const scriptDirectory = Path.dirname(fileURLToPath(import.meta.url));
const webRoot = Path.resolve(scriptDirectory, "../../..");
const repositoryRoot = Path.resolve(webRoot, "../..");
const composeFile = Path.join(
  webRoot,
  "modules/ai-reviewer/test/fixtures/ollama/docker-compose.yml",
);
const composePrefix = [
  "compose",
  "-p",
  "overleaf-ai-ollama-smoke",
  "-f",
  composeFile,
];

function parseArguments(argv) {
  const options = {
    baseUrl: null,
    model: "qwen3.5:4b",
    output: ".loop/runs/eval-ollama-smoke.json",
    probe: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--probe") {
      options.probe = true;
    } else if (["--base-url", "--model", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${argument} requires a value.`);
      }
      options[
        argument === "--base-url"
          ? "baseUrl"
          : argument === "--model"
            ? "model"
            : "output"
      ] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.probe && options.baseUrl == null) {
    throw new Error("--probe requires --base-url.");
  }
  return options;
}

function run(
  command,
  args,
  { capture = false, cwd = repositoryRoot, env } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `${command} exited with ${code ?? `signal ${String(signal)}`}.`,
          ),
        );
      }
    });
  });
}

async function streamProbe(baseUrl, model) {
  const started = performance.now();
  const transport = new OllamaOpenAiTransport({
    baseUrl,
    modelTag: model,
  });
  let text = "";
  let completed = null;
  for await (const event of transport.streamChat({
    prompt: "Return exactly COMPAT_OK and nothing else.",
    maxOutputTokens: 32,
  })) {
    if (event.type === "text.delta") {
      text += event.delta;
    } else {
      completed = event;
    }
  }
  if (text !== "COMPAT_OK" || completed?.finishReason !== "stop") {
    throw new Error("The Ollama stream compatibility probe failed.");
  }
  return {
    ok: true,
    durationMs: Math.round(performance.now() - started),
    inputTokens: completed.usage.inputTokens,
    outputTokens: completed.usage.outputTokens,
  };
}

async function readLoadedModel(model) {
  const response = await fetch("http://127.0.0.1:11434/api/ps");
  if (!response.ok) {
    throw new Error(`Ollama model inventory returned HTTP ${response.status}.`);
  }
  const body = await response.json();
  const entry = body.models?.find(
    (candidate) => candidate.name === model || candidate.model === model,
  );
  return entry == null
    ? null
    : {
        name: entry.name ?? entry.model,
        digest: entry.digest,
        sizeBytes: entry.size,
        sizeVramBytes: entry.size_vram,
        contextLength: entry.context_length,
      };
}

async function unloadModel(model) {
  const response = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, keep_alive: 0, stream: false }),
  });
  if (!response.ok) {
    throw new Error(`Ollama unload returned HTTP ${response.status}.`);
  }
}

async function runAcceptance(enabled, options) {
  await run("yarn", ["local:test:acceptance:run_module"], {
    cwd: webRoot,
    env: {
      ...process.env,
      MODULE: "ai-reviewer",
      OVERLEAF_APP: "server-ce",
      OVERLEAF_AI_REVIEWER_ENABLED: String(enabled),
      ...(enabled
        ? {
            OVERLEAF_AI_REVIEWER_REAL_OLLAMA: "true",
            OVERLEAF_AI_REVIEWER_OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
            OVERLEAF_AI_REVIEWER_OLLAMA_MODEL: options.model,
          }
        : {}),
    },
  });
}

async function writeResult(output, result) {
  const outputPath = Path.resolve(repositoryRoot, output);
  await mkdir(Path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
}

const options = parseArguments(process.argv.slice(2));
if (options.probe) {
  process.stdout.write(
    `${JSON.stringify(await streamProbe(options.baseUrl, options.model))}\n`,
  );
} else {
  const result = {
    version: 1,
    model: options.model,
    startedAt: new Date().toISOString(),
    host: null,
    container: null,
    featureOffAcceptance: false,
    authenticatedAcceptance: false,
    loadedModel: null,
    cleanup: { compose: false, modelUnloaded: false },
    ok: false,
  };
  let failure = null;
  try {
    result.host = await streamProbe("http://127.0.0.1:11434/v1", options.model);
    await run("docker", [...composePrefix, "up", "-d", "--wait"]);
    result.container = JSON.parse(
      await run(
        "docker",
        [
          ...composePrefix,
          "exec",
          "-T",
          "web-probe",
          "node",
          "modules/ai-reviewer/scripts/run-ollama-smoke.mjs",
          "--probe",
          "--base-url",
          "http://host.docker.internal:11434/v1",
          "--model",
          options.model,
        ],
        { capture: true },
      ),
    );
    await runAcceptance(false, options);
    result.featureOffAcceptance = true;
    await runAcceptance(true, options);
    result.authenticatedAcceptance = true;
    result.loadedModel = await readLoadedModel(options.model);
    result.ok = true;
  } catch (error) {
    failure = error;
    result.error = String(error?.message ?? error).slice(0, 500);
  } finally {
    try {
      await unloadModel(options.model);
      result.cleanup.modelUnloaded = true;
    } catch (error) {
      result.cleanup.modelError = String(error?.message ?? error).slice(0, 200);
    }
    try {
      await run("docker", [
        ...composePrefix,
        "down",
        "--volumes",
        "--remove-orphans",
      ]);
      result.cleanup.compose = true;
    } catch (error) {
      result.cleanup.composeError = String(error?.message ?? error).slice(
        0,
        200,
      );
    }
    result.finishedAt = new Date().toISOString();
    await writeResult(options.output, result);
  }
  if (failure != null) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Ollama smoke passed; result: ${Path.resolve(repositoryRoot, options.output)}\n`,
    );
  }
}
