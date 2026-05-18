"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { URL } = require("node:url");

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const cloud = process.env.CLOUD ?? "local";
const region = process.env.REGION ?? "local";
const stageRoute = parseList(process.env.STAGE_ROUTE ?? "aws,gcp,azure");
const stageUrlConfigDir = process.env.STAGE_URL_CONFIG_DIR ?? "/config/stage-urls";
const stageUrlEnv = {
  aws: process.env.AWS_STAGE_URL ?? "",
  gcp: process.env.GCP_STAGE_URL ?? "",
  azure: process.env.AZURE_STAGE_URL ?? "",
};
const failReady = (process.env.FAIL_READY ?? "false").toLowerCase() === "true";
const errorRate = Number.parseFloat(process.env.ERROR_RATE ?? "0");
const serviceName = process.env.OTEL_SERVICE_NAME ?? "mandelbrot";
const zipkinEndpoint = process.env.ZIPKIN_ENDPOINT ?? "";
const zipkinEndpoints = parseList(process.env.ZIPKIN_ENDPOINTS ?? zipkinEndpoint);
const traceSampleRate = sanitizeNumber(process.env.TRACE_SAMPLE_RATE, 1, 0, 1);

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

function nowIso() {
  return new Date().toISOString();
}

function log(level, message, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({
      time: nowIso(),
      level,
      message,
      platform: "trinity",
      service: serviceName,
      cloud,
      region,
      pod: os.hostname(),
      ...fields,
    })}\n`,
  );
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function shouldSample(parentContext) {
  if (parentContext?.sampled !== undefined) {
    return parentContext.sampled;
  }

  return Math.random() < traceSampleRate;
}

function parseTraceContext(req) {
  const traceId = req.headers["x-b3-traceid"];
  const spanId = req.headers["x-b3-spanid"];
  const sampled = req.headers["x-b3-sampled"];

  if (
    typeof traceId === "string" &&
    /^[0-9a-f]{16,32}$/i.test(traceId) &&
    typeof spanId === "string" &&
    /^[0-9a-f]{16}$/i.test(spanId)
  ) {
    return {
      traceId: traceId.toLowerCase(),
      spanId: spanId.toLowerCase(),
      sampled: typeof sampled === "string"
        ? sampled === "1" || sampled === "true"
        : undefined,
    };
  }

  return undefined;
}

function startSpan(name, kind, parentContext, tags = {}) {
  const sampled = shouldSample(parentContext);

  return {
    traceId: parentContext?.traceId ?? randomHex(16),
    parentId: parentContext?.spanId,
    spanId: randomHex(8),
    name,
    kind,
    sampled,
    startedAtMicros: Date.now() * 1000,
    startedAt: performance.now(),
    tags,
  };
}

function spanContext(span) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    sampled: span.sampled,
  };
}

function traceHeaders(span) {
  return {
    "x-b3-traceid": span.traceId,
    "x-b3-spanid": span.spanId,
    "x-b3-sampled": span.sampled ? "1" : "0",
  };
}

function finishSpan(span, tags = {}) {
  if (!span.sampled || zipkinEndpoints.length === 0) {
    return;
  }

  const durationMicros = Math.max(
    1,
    Math.round((performance.now() - span.startedAt) * 1000),
  );
  const zipkinSpan = {
    traceId: span.traceId,
    id: span.spanId,
    name: span.name,
    kind: span.kind,
    timestamp: span.startedAtMicros,
    duration: durationMicros,
    localEndpoint: {
      serviceName,
    },
    tags: {
      cloud,
      region,
      pod: os.hostname(),
      ...span.tags,
      ...tags,
    },
  };

  if (span.parentId) {
    zipkinSpan.parentId = span.parentId;
  }

  for (const endpoint of zipkinEndpoints) {
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([zipkinSpan]),
    })
      .then(async (response) => {
        if (response.ok) {
          return;
        }

        const body = await response.text().catch(() => "");
        log("error", "zipkin export failed", {
          endpoint,
          traceId: span.traceId,
          spanId: span.spanId,
          statusCode: response.status,
          statusText: response.statusText,
          responseBody: body.slice(0, 240),
        });
      })
      .catch((error) => {
        log("error", "zipkin export failed", {
          endpoint,
          traceId: span.traceId,
          spanId: span.spanId,
          error: error.message,
        });
      });
  }
}

function readStageUrlFromFile(targetCloud) {
  const fileName = `${targetCloud.toUpperCase()}_STAGE_URL`;

  try {
    return fs.readFileSync(path.join(stageUrlConfigDir, fileName), "utf8").trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function stageUrlFor(targetCloud) {
  return readStageUrlFromFile(targetCloud) || stageUrlEnv[targetCloud] || "";
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

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
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

async function runStage(targetCloud, body, parentContext) {
  const targetUrl = stageUrlFor(targetCloud);
  const span = startSpan(`render stage ${targetCloud}`, "CLIENT", parentContext, {
    "stage.requested_cloud": targetCloud,
  });

  try {
    let result;

    if (!targetUrl || targetCloud === cloud || targetCloud === "local") {
      result = renderStage(body, spanContext(span));
    } else {
      const endpoint = new URL("/internal/render-stage", targetUrl).toString();
      result = await postJson(endpoint, body, traceHeaders(span));
    }

    finishSpan(span, {
      "stage.rendered_cloud": result.cloud,
      "stage.status": "ok",
    });
    return result;
  } catch (error) {
    finishSpan(span, {
      "stage.status": "error",
      error: error.message,
    });
    throw error;
  }
}

function maybeFail() {
  if (errorRate > 0 && Math.random() < errorRate) {
    throw new Error("Injected stage failure.");
  }
}

function renderStage(body, parentContext) {
  const span = startSpan("render tile", "SERVER", parentContext, {
    "job.id": body.jobId,
  });

  try {
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

    finishSpan(span, {
      "stage.index": String(stageIndex),
      "stage.count": String(stageCount),
      "stage.status": "ok",
      "tile.pixels": String(tile.totalPixels),
    });

    log("info", "mandelbrot stage rendered", {
      traceId: span.traceId,
      spanId: span.spanId,
      jobId: body.jobId,
      stageIndex,
      stageCount,
      durationMs,
      totalPixels: tile.totalPixels,
      escaped: tile.escaped,
    });

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
  } catch (error) {
    finishSpan(span, {
      "stage.status": "error",
      error: error.message,
    });
    throw error;
  }
}

async function renderJob(input, parentContext) {
  const id = jobId();
  const params = sanitizeParams(input.params);
  const route = routeForRequest(input);
  const strict = input.failureMode !== "degraded";
  const started = performance.now();

  const stageResults = await Promise.all(
    route.map(async (targetCloud, index) => {
      try {
        const result = await runStage(
          targetCloud,
          {
            jobId: id,
            params,
            stageIndex: index,
            stageCount: route.length,
          },
          parentContext,
        );

        return {
          stage: {
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
          },
          tile: result.tile,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("warn", "mandelbrot stage failed", {
          traceId: parentContext?.traceId,
          spanId: parentContext?.spanId,
          jobId: id,
          requestedCloud: targetCloud,
          error: message,
        });

        return {
          stage: {
            status: "error",
            requestedCloud: targetCloud,
            error: message,
          },
          error: message,
        };
      }
    }),
  );

  const stages = stageResults.map((result) => result.stage);
  const tiles = stageResults
    .filter((result) => result.tile)
    .map((result) => result.tile);
  const failedStage = stageResults.find((result) => result.error);

  if (strict && failedStage) {
    throw Object.assign(
      new Error(
        `Stage ${failedStage.stage.requestedCloud} failed: ${failedStage.error}`,
      ),
      {
        partial: { id, params, route, stages, tiles },
      },
    );
  }

  const result = {
    id,
    cloud,
    region,
    route,
    params,
    status: failedStage ? "degraded" : "complete",
    durationMs: Math.round(performance.now() - started),
    stages,
    tiles,
  };

  log("info", "mandelbrot render completed", {
    traceId: parentContext?.traceId,
    spanId: parentContext?.spanId,
    jobId: id,
    status: result.status,
    route: route.join(","),
    durationMs: result.durationMs,
  });

  return result;
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
  const requestStarted = performance.now();
  const parentContext = parseTraceContext(req);
  const requestSpan = startSpan(
    `${req.method ?? "GET"} ${(req.url ?? "/").split("?")[0]}`,
    "SERVER",
    parentContext,
    {
      "http.method": req.method ?? "",
      "http.route": (req.url ?? "/").split("?")[0],
    },
  );

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
        const result = await renderJob(body, spanContext(requestSpan));
        metrics.renderRequests.ok += 1;
        jsonResponse(res, 200, result);
        log("info", "request completed", {
          traceId: requestSpan.traceId,
          spanId: requestSpan.spanId,
          method: req.method,
          path: url.pathname,
          statusCode: 200,
          durationMs: Math.round(performance.now() - requestStarted),
        });
        finishSpan(requestSpan, { "http.status_code": "200" });
      } catch (error) {
        metrics.renderRequests.error += 1;
        jsonResponse(res, 500, {
          error: error.message,
          partial: error.partial,
        });
        log("error", "request failed", {
          traceId: requestSpan.traceId,
          spanId: requestSpan.spanId,
          method: req.method,
          path: url.pathname,
          statusCode: 500,
          durationMs: Math.round(performance.now() - requestStarted),
          error: error.message,
        });
        finishSpan(requestSpan, {
          "http.status_code": "500",
          error: error.message,
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/internal/render-stage") {
      const body = await readJson(req);
      try {
        jsonResponse(res, 200, renderStage(body, spanContext(requestSpan)));
        finishSpan(requestSpan, { "http.status_code": "200" });
      } catch (error) {
        metrics.stageRenders.error += 1;
        jsonResponse(res, 500, { error: error.message });
        log("error", "stage request failed", {
          traceId: requestSpan.traceId,
          spanId: requestSpan.spanId,
          method: req.method,
          path: url.pathname,
          statusCode: 500,
          durationMs: Math.round(performance.now() - requestStarted),
          error: error.message,
        });
        finishSpan(requestSpan, {
          "http.status_code": "500",
          error: error.message,
        });
      }
      return;
    }

    jsonResponse(res, 404, { error: "Not found." });
    finishSpan(requestSpan, { "http.status_code": "404" });
  } catch (error) {
    jsonResponse(res, 500, { error: error.message });
    log("error", "request failed", {
      traceId: requestSpan.traceId,
      spanId: requestSpan.spanId,
      method: req.method,
      statusCode: 500,
      durationMs: Math.round(performance.now() - requestStarted),
      error: error.message,
    });
    finishSpan(requestSpan, {
      "http.status_code": "500",
      error: error.message,
    });
  }
});

server.listen(port, () => {
  log("info", "mandelbrot service listening", {
    port,
    tracingEnabled: zipkinEndpoints.length > 0,
    zipkinEndpoints: zipkinEndpoints.join(","),
  });
});
