const UPSTREAM_ORIGIN = "https://downstream.jbbtoken.cn";
const UPSTREAM_HOST = "downstream.jbbtoken.cn";
const AFFILIATE_CODE = "iVAt";
const AFFILIATE_PARAM = "aff";

const REGISTER_PATHS = new Set([
  "/sign-up",
  "/signup",
  "/register",
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (isRegisterPath(url.pathname) && url.searchParams.get(AFFILIATE_PARAM) !== AFFILIATE_CODE) {
      return redirectToMirrorAffiliateSignup(url);
    }

    const upstreamUrl = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);
    const upstreamRequest = await buildUpstreamRequest(request, upstreamUrl);
    const upstreamResponse = await fetch(upstreamRequest);

    if (isRedirect(upstreamResponse.status)) {
      return rewriteRedirect(upstreamResponse, url);
    }

    if (!shouldRewriteBody(upstreamResponse)) {
      return upstreamResponse;
    }

    return rewriteTextResponse(upstreamResponse, url);
  },
};

function isRegisterPath(pathname) {
  const normalized = normalizePath(pathname);
  if (REGISTER_PATHS.has(normalized)) return true;
  return [...REGISTER_PATHS].some((path) => normalized.startsWith(`${path}/`));
}

function normalizePath(pathname) {
  const decoded = safeDecode(pathname).toLowerCase();
  const withoutTrailingSlash = decoded.replace(/\/+$/, "");
  return withoutTrailingSlash || "/";
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redirectToMirrorAffiliateSignup(requestUrl) {
  const targetUrl = new URL(requestUrl);
  targetUrl.searchParams.set(AFFILIATE_PARAM, AFFILIATE_CODE);

  return new Response(null, {
    status: 302,
    headers: {
      Location: targetUrl.toString(),
      "Cache-Control": "no-store",
    },
  });
}

async function buildUpstreamRequest(request, upstreamUrl) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("accept-encoding");
  headers.delete("content-length");

  const origin = headers.get("origin");
  if (origin) {
    headers.set("origin", UPSTREAM_ORIGIN);
  }

  const referer = headers.get("referer");
  if (referer) {
    headers.set("referer", referer.replace(/^https?:\/\/[^/]+/i, UPSTREAM_ORIGIN));
  }

  headers.set("x-forwarded-host", new URL(request.url).host);
  headers.set("x-mirror-origin", new URL(request.url).origin);

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await buildUpstreamBody(request, upstreamUrl, headers);
  }

  return new Request(upstreamUrl.toString(), init);
}

async function buildUpstreamBody(request, upstreamUrl, headers) {
  if (isRegisterApiRequest(request, upstreamUrl)) {
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        const payload = await request.clone().json();
        payload.aff_code = AFFILIATE_CODE;
        headers.set("content-type", "application/json");
        return JSON.stringify(payload);
      } catch {
        return request.body;
      }
    }
  }

  return request.body;
}

function isRegisterApiRequest(request, upstreamUrl) {
  return request.method.toUpperCase() === "POST" && normalizePath(upstreamUrl.pathname) === "/api/user/register";
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

function rewriteRedirect(response, requestUrl) {
  const headers = new Headers(response.headers);
  const location = headers.get("location");

  if (location) {
    headers.set("location", rewriteLocation(location, requestUrl));
  }

  headers.set("cache-control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteLocation(location, requestUrl) {
  let locationUrl;
  try {
    locationUrl = new URL(location, UPSTREAM_ORIGIN);
  } catch {
    return location;
  }

  if (locationUrl.hostname === UPSTREAM_HOST && isRegisterPath(locationUrl.pathname)) {
    locationUrl.protocol = requestUrl.protocol;
    locationUrl.host = requestUrl.host;
    locationUrl.searchParams.set(AFFILIATE_PARAM, AFFILIATE_CODE);
    return locationUrl.toString();
  }

  if (locationUrl.hostname === UPSTREAM_HOST) {
    locationUrl.protocol = requestUrl.protocol;
    locationUrl.host = requestUrl.host;
    return locationUrl.toString();
  }

  return location;
}

function shouldRewriteBody(response) {
  const contentType = response.headers.get("content-type") || "";
  return /(?:text\/|javascript|json|xml|svg|html|css)/i.test(contentType);
}

async function rewriteTextResponse(response, requestUrl) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");

  const contentType = headers.get("content-type") || "";
  const isHtml = /text\/html/i.test(contentType);
  if (isHtml) {
    headers.set("cache-control", "no-store");
  }

  const text = await response.text();
  const rewritten = rewriteUpstreamReferences(text, requestUrl, isHtml);

  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteUpstreamReferences(text, requestUrl, isHtml = false) {
  const currentOrigin = requestUrl.origin;
  const currentHost = requestUrl.host;

  const rewritten = text
    .replaceAll("https://downstream.jbbtoken.cn", currentOrigin)
    .replaceAll("http://downstream.jbbtoken.cn", currentOrigin)
    .replaceAll("//downstream.jbbtoken.cn", `//${currentHost}`)
    .replaceAll("downstream.jbbtoken.cn", currentHost);

  return isHtml ? injectAffiliateRouteNormalizer(rewritten) : rewritten;
}

function injectAffiliateRouteNormalizer(html) {
  if (html.includes("jbb-affiliate-route-normalizer")) {
    return html;
  }

  const script = `<script id="jbb-affiliate-route-normalizer">
(function () {
  var affiliateCode = "iVAt";
  var affiliateParam = "aff";
  var registerPaths = { "/sign-up": true, "/signup": true, "/register": true };

  function normalizePath(pathname) {
    var normalized = String(pathname || "/").toLowerCase().replace(/\\/+$/, "");
    return normalized || "/";
  }

  function shouldTag(pathname) {
    var normalized = normalizePath(pathname);
    if (registerPaths[normalized]) return true;
    return Object.keys(registerPaths).some(function (path) {
      return normalized.indexOf(path + "/") === 0;
    });
  }

  function addAffiliateParam(url) {
    if (url.origin !== window.location.origin || !shouldTag(url.pathname)) return false;
    if (url.searchParams.get(affiliateParam) === affiliateCode) return false;
    url.searchParams.set(affiliateParam, affiliateCode);
    return true;
  }

  function normalizeTarget(value) {
    if (value == null) return value;
    try {
      var url = new URL(value, window.location.href);
      if (!addAffiliateParam(url)) return value;
      return url.pathname + url.search + url.hash;
    } catch (_) {
      return value;
    }
  }

  function ensureCurrentUrl() {
    try {
      var url = new URL(window.location.href);
      if (addAffiliateParam(url)) {
        window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      }
    } catch (_) {}
  }

  var pushState = window.history.pushState;
  var replaceState = window.history.replaceState;

  window.history.pushState = function (state, title, url) {
    return pushState.call(this, state, title, normalizeTarget(url));
  };

  window.history.replaceState = function (state, title, url) {
    return replaceState.call(this, state, title, normalizeTarget(url));
  };

  window.addEventListener("popstate", ensureCurrentUrl);
  ensureCurrentUrl();
})();
</script>`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${script}`);
  }

  return `${script}\n${html}`;
}
