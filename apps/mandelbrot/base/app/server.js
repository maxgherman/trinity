"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const { URL } = require("node:url");

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const cloud = process.env.CLOUD ?? "local";
const region = process.env.REGION ?? "local";
const stageRoute = parseList(process.env.STAGE_ROUTE ?? "aws,gcp,azure");
const stageUrls = {
  aws: process.env.AWS_STAGE_URL ?? "",
  gcp: process.env.GCP_STAGE_URL ?? "",
  azure: process.env.AZURE_STAGE_URL ?? "",
};
const failReady = (process.env.FAIL_READY ?? "false").toLowerCase() === "true";
const errorRate = Number.parseFloat(process.env.ERROR_RATE ?? "0");

const metrics = {
  renderRequests: { ok: 0, error: 0 },
  stageRenders: { ok: 0, error: 0 },
  stageRenderSeconds: { count: 0, sum: 0 },
};

function parseList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function textResponse(res, statusCode, body, contentType = "text/plain") {
  res.writeHead(statusCode, {
    "content-type": `${contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sanitizeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeParams(input = {}) {
  return {
    width: Math.round(sanitizeNumber(input.width, 480, 64, 900)),
    height: Math.round(sanitizeNumber(input.height, 300, 64, 700)),
    maxIterations: Math.round(
      sanitizeNumber(input.maxIterations, 180, 25, 1_200),
    ),
    xMin: sanitizeNumber(input.xMin, -2.1, -3, 1),
    xMax: sanitizeNumber(input.xMax, 0.8, -1, 3),
    yMin: sanitizeNumber(input.yMin, -1.1, -2, 1),
    yMax: sanitizeNumber(input.yMax, 1.1, -1, 2),
  };
}

function routeForRequest(input = {}) {
  const requestedRoute = Array.isArray(input.route)
    ? input.route.filter((item) => typeof item === "string")
    : stageRoute;

  const route = requestedRoute
    .map((item) => item.toLowerCase())
    .filter((item) => ["aws", "gcp", "azure", "local"].includes(item));

  if (route.length === 0) {
    return ["local"];
  }

  if (input.routeMode === "start-local" && route.includes(cloud)) {
    const localIndex = route.indexOf(cloud);
    return route.slice(localIndex).concat(route.slice(0, localIndex));
  }

  return route;
}

function jobId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function colorForIteration(iteration, maxIterations) {
  if (iteration >= maxIterations) {
    return [8, 10, 18, 255];
  }

  const t = iteration / maxIterations;
  const r = Math.round(32 + 220 * Math.pow(t, 0.45));
  const g = Math.round(42 + 170 * Math.sin(Math.PI * t));
  const b = Math.round(90 + 145 * Math.pow(1 - t, 0.35));
  return [r, g, b, 255];
}

function renderTile(params, stageIndex, stageCount) {
  const { width, height, maxIterations, xMin, xMax, yMin, yMax } = params;
  const yStart = Math.floor((height * stageIndex) / stageCount);
  const yEnd = Math.floor((height * (stageIndex + 1)) / stageCount);
  const tileHeight = yEnd - yStart;
  const pixels = Buffer.alloc(width * tileHeight * 4);
  let escaped = 0;
  let offset = 0;

  for (let py = yStart; py < yEnd; py += 1) {
    const cy = yMin + (py / Math.max(1, height - 1)) * (yMax - yMin);

    for (let px = 0; px < width; px += 1) {
      const cx = xMin + (px / Math.max(1, width - 1)) * (xMax - xMin);
      let x = 0;
      let y = 0;
      let iteration = 0;

      while (x * x + y * y <= 4 && iteration < maxIterations) {
        const xNext = x * x - y * y + cx;
        y = 2 * x * y + cy;
        x = xNext;
        iteration += 1;
      }

      if (iteration < maxIterations) {
        escaped += 1;
      }

      const [r, g, b, a] = colorForIteration(iteration, maxIterations);
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = a;
      offset += 4;
    }
  }

  return {
    yStart,
    yEnd,
    width,
    height,
    pixels: pixels.toString("base64"),
    escaped,
    totalPixels: width * tileHeight,
  };
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Stage returned HTTP ${response.status}.`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function runStage(targetCloud, body) {
  const targetUrl = stageUrls[targetCloud];

  if (!targetUrl || targetCloud === cloud || targetCloud === "local") {
    return renderStage(body);
  }

  const endpoint = new URL("/internal/render-stage", targetUrl).toString();
  return postJson(endpoint, body);
}

function maybeFail() {
  if (errorRate > 0 && Math.random() < errorRate) {
    throw new Error("Injected stage failure.");
  }
}

function renderStage(body) {
  maybeFail();
  const started = performance.now();
  const params = sanitizeParams(body.params);
  const stageIndex = Math.round(
    sanitizeNumber(body.stageIndex, 0, 0, Math.max(0, body.stageCount - 1)),
  );
  const stageCount = Math.round(sanitizeNumber(body.stageCount, 1, 1, 12));
  const tile = renderTile(params, stageIndex, stageCount);
  const durationMs = Math.round(performance.now() - started);

  metrics.stageRenders.ok += 1;
  metrics.stageRenderSeconds.count += 1;
  metrics.stageRenderSeconds.sum += durationMs / 1000;

  return {
    jobId: body.jobId,
    stageIndex,
    stageCount,
    cloud,
    region,
    pod: os.hostname(),
    durationMs,
    pixelsPerSecond: Math.round(tile.totalPixels / Math.max(0.001, durationMs / 1000)),
    tile,
  };
}

async function renderJob(input) {
  const id = jobId();
  const params = sanitizeParams(input.params);
  const route = routeForRequest(input);
  const strict = input.failureMode !== "degraded";
  const stages = [];
  const tiles = [];
  const started = performance.now();

  for (let index = 0; index < route.length; index += 1) {
    const targetCloud = route[index];
    try {
      const result = await runStage(targetCloud, {
        jobId: id,
        params,
        stageIndex: index,
        stageCount: route.length,
      });
      stages.push({
        status: "ok",
        cloud: result.cloud,
        requestedCloud: targetCloud,
        region: result.region,
        pod: result.pod,
        durationMs: result.durationMs,
        pixelsPerSecond: result.pixelsPerSecond,
        yStart: result.tile.yStart,
        yEnd: result.tile.yEnd,
        escaped: result.tile.escaped,
        totalPixels: result.tile.totalPixels,
      });
      tiles.push(result.tile);
    } catch (error) {
      stages.push({
        status: "error",
        requestedCloud: targetCloud,
        error: error.message,
      });

      if (strict) {
        throw Object.assign(new Error(`Stage ${targetCloud} failed: ${error.message}`), {
          partial: { id, params, route, stages, tiles },
        });
      }
    }
  }

  return {
    id,
    cloud,
    region,
    route,
    params,
    status: stages.some((stage) => stage.status === "error") ? "degraded" : "complete",
    durationMs: Math.round(performance.now() - started),
    stages,
    tiles,
  };
}

function metricsBody() {
  const labels = `{cloud="${cloud}",region="${region}"}`;
  return [
    "# HELP mandelbrot_render_requests_total Render requests handled by this service.",
    "# TYPE mandelbrot_render_requests_total counter",
    `mandelbrot_render_requests_total${labels.replace("}", ',status="ok"}')} ${metrics.renderRequests.ok}`,
    `mandelbrot_render_requests_total${labels.replace("}", ',status="error"}')} ${metrics.renderRequests.error}`,
    "# HELP mandelbrot_stage_renders_total Stage renders handled by this service.",
    "# TYPE mandelbrot_stage_renders_total counter",
    `mandelbrot_stage_renders_total${labels.replace("}", ',status="ok"}')} ${metrics.stageRenders.ok}`,
    `mandelbrot_stage_renders_total${labels.replace("}", ',status="error"}')} ${metrics.stageRenders.error}`,
    "# HELP mandelbrot_stage_render_seconds Stage render duration in seconds.",
    "# TYPE mandelbrot_stage_render_seconds summary",
    `mandelbrot_stage_render_seconds_count${labels} ${metrics.stageRenderSeconds.count}`,
    `mandelbrot_stage_render_seconds_sum${labels} ${metrics.stageRenderSeconds.sum.toFixed(6)}`,
    "",
  ].join("\n");
}

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      textResponse(res, 200, html, "text/html");
      return;
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/readyz") {
      jsonResponse(res, failReady ? 503 : 200, { ok: !failReady, cloud, region });
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      textResponse(res, 200, metricsBody());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/meta") {
      jsonResponse(res, 200, { cloud, region, pod: os.hostname(), route: stageRoute });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/render") {
      const body = await readJson(req);
      try {
        const result = await renderJob(body);
        metrics.renderRequests.ok += 1;
        jsonResponse(res, 200, result);
      } catch (error) {
        metrics.renderRequests.error += 1;
        jsonResponse(res, 500, {
          error: error.message,
          partial: error.partial,
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/internal/render-stage") {
      const body = await readJson(req);
      try {
        jsonResponse(res, 200, renderStage(body));
      } catch (error) {
        metrics.stageRenders.error += 1;
        jsonResponse(res, 500, { error: error.message });
      }
      return;
    }

    jsonResponse(res, 404, { error: "Not found." });
  } catch (error) {
    jsonResponse(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`mandelbrot service listening on ${port}`);
});
